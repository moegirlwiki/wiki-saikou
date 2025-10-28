import { FexiosConfigs, FexiosRequestOptions, FexiosFinalContext } from 'fexios'
import { createFexiosSaikou, FexiosSaikou } from './models/FexiosSaikou.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import { deepMerge } from './utils/deepMerge.js'
import { useRetry } from './utils/useRetry.js'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './models/errors.js'
import { MwApiParams, MwApiResponse, MwTokenName } from './types.js'

export interface WikiSaikouConfig {
  /**
   * @default undefined // required in Node.js environment
   * @default `${wgServer}${wgScriptPath}/api.php` // in MW pages
   * @description The MediaWiki API endpoint, e.g. "https://www.mediawiki.org/w/api.php"
   * @optional In real MediaWiki browser pages, `baseURL` can be omitted and will be inferred automatically based on `window.mw`
   */
  baseURL: string
  /**
   * Transport/runtime options passed to the underlying Fexios instance (headers, fetch, credentials, etc.).
   * @default { responseType: 'json' }
   */
  fexiosConfigs: Partial<FexiosConfigs>
  /**
   * Default query parameters merged into every request.
   * @default { action: 'query' }
   */
  defaultParams: MwApiParams
  /**
   * When true, responses whose JSON body contains `error`/`errors` will throw `MediaWikiApiError` even if HTTP status is 2xx.
   * @default false
   */
  throwOnApiError: boolean
}

export type WikiSaikouInitConfig = Omit<
  Partial<WikiSaikouConfig>,
  'baseURL'
> & {
  baseURL: string
}

/**
 * WikiSaikou Core class
 * @internal You **SHOULD NOT** use this class directly, instead, use the `MediaWikiApi` class.
 * @author dragon-fish <dragon-fish@qq.com>
 * @license MIT
 */
export class WikiSaikouCore {
  readonly config: Required<WikiSaikouConfig>
  readonly version = import.meta.env.__VERSION__
  readonly request: FexiosSaikou

  static INIT_DEFAULT_PARAMS: MwApiParams = {
    action: 'query',
    errorformat: 'plaintext',
    format: 'json',
    formatversion: 2,
  }
  static DEFAULT_CONFIGS: Required<WikiSaikouConfig> = {
    baseURL: undefined as unknown as string,
    fexiosConfigs: {
      responseType: 'json',
    },
    defaultParams: this.INIT_DEFAULT_PARAMS,
    throwOnApiError: false,
  }

  /** @deprecated Use `new MediaWikiApi(config)` instead */
  constructor(
    baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  )
  constructor(config?: WikiSaikouInitConfig)
  constructor(
    configOrBaseURL?: WikiSaikouInitConfig | string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    const config = (this.config = resolveLegacyCtor(
      configOrBaseURL,
      defaultOptions,
      defaultParams
    ))
    this.request = createFexiosSaikou(config.baseURL)
  }

  setBaseURL(baseURL: string) {
    this.config.baseURL = baseURL
    this.request.baseConfigs.baseURL = baseURL
    return this
  }

  /** Base methods encapsulation */
  async get<T = any>(
    query: MwApiParams,
    options?: Partial<FexiosRequestOptions>
  ) {
    return this.runRequestWithApiErrorMapping(() =>
      this.request.get<MwApiResponse<T>>(
        '',
        deepMerge(
          this.config.fexiosConfigs,
          { query: deepMerge(this.config.defaultParams, query) },
          options
        )
      )
    )
  }
  async post<T = any>(
    data: MwApiParams | URLSearchParams | FormData,
    options?: Partial<FexiosRequestOptions>
  ) {
    return this.runRequestWithApiErrorMapping(() =>
      this.request.post<MwApiResponse<T>>(
        '',
        data,
        deepMerge(
          this.config.fexiosConfigs,
          {
            query: this.config.defaultParams,
          },
          options
        )
      )
    )
  }

  /**
   * Wrap a request to map non-2xx responses containing MediaWiki API error bodies
   * into MediaWikiApiError when throwOnApiError=true, and then pass 2xx responses
   * through handleApiResponse for unified processing.
   */
  private async runRequestWithApiErrorMapping<T = any>(
    doRequest: () => Promise<FexiosFinalContext<MwApiResponse<T>>>
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    try {
      const res = await doRequest()
      return this.handleApiResponse(res)
    } catch (err) {
      // If HTTP is non-2xx but body includes MW API error, convert to MediaWikiApiError
      if (
        this.config.throwOnApiError &&
        WikiSaikouError.includesMediaWikiApiError(err)
      ) {
        throw new MediaWikiApiError(
          WikiSaikouError.extractMediaWikiApiErrors(err),
          err as any
        )
      }
      throw err as any
    }
  }

  private throwIfApiError(data?: any) {
    const errors = WikiSaikouError.extractMediaWikiApiErrors(data)
    if (errors.length > 0) {
      throw new MediaWikiApiError(errors, data)
    }
  }
  private handleApiResponse<T = any>(
    res: FexiosFinalContext<MwApiResponse<T>>
  ) {
    if (this.config.throwOnApiError) {
      this.throwIfApiError(res.data)
    }
    return res
  }

  /** Token Handler */
  get tokens() {
    return this.request._tokens
  }
  async fetchTokens(types: MwTokenName[] = ['csrf']) {
    this.config.fexiosConfigs.credentials = 'include'
    await this.get<{
      query: { tokens: Record<MwTokenName, string> }
    }>({
      action: 'query',
      meta: 'tokens',
      type: types,
    })
    return this.tokens
  }
  async getToken(type: MwTokenName = 'csrf', noCache = false) {
    if (!this.tokens.get(type) || noCache) {
      this.tokens.delete(type)
      await this.fetchTokens([type])
    }
    return this.tokens.get(type)!
  }
  badToken(type: MwTokenName) {
    this.tokens.delete(type)
    return this.tokens
  }

  async postWithToken<T = any>(
    tokenType: MwTokenName,
    body: MwApiParams,
    options?: {
      tokenName?: string
      retry?: number
      noCache?: boolean
      fexiosOptions?: Partial<FexiosRequestOptions>
    }
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const {
      tokenName = 'token',
      retry = 3,
      noCache = false,
      fexiosOptions,
    } = options || {}

    if (retry < 1) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
        'The limit of the number of times to automatically re-acquire the token has been exceeded'
      )
    }

    let attemptIndex = 0
    return useRetry<FexiosFinalContext<MwApiResponse<T>>>(
      async () => {
        const token = await this.getToken(
          tokenType,
          noCache || attemptIndex > 0
        )

        try {
          const ctx = await this.post<MwApiResponse<T>>(
            {
              [tokenName]: token,
              ...body,
            },
            deepMerge(fexiosOptions || {}, {
              headers: { 'x-mw-token-name': tokenType },
            })
          )

          if (WikiSaikouError.isBadTokenError(ctx.data)) {
            throw ctx
          }
          return ctx
        } catch (err: any) {
          if (WikiSaikouError.isBadTokenError(err) || err?.ok === false) {
            throw err
          } else if (MediaWikiApiError.is(err)) {
            // MW 业务错误，直接透传
            throw err
          } else {
            throw new WikiSaikouError(
              WikiSaikouErrorCode.HTTP_ERROR,
              'Network/transport or SDK-internal error (not a MediaWiki API error)',
              err
            )
          }
        }
      },
      {
        retry,
        onRetry: (_error, count) => {
          attemptIndex = count + 1
        },
        shouldRetry: (error) =>
          WikiSaikouError.isBadTokenError(error) ||
          (error as any)?.ok === false,
      }
    ).catch((err) => {
      // Map exhausted retry of retryable errors into SDK-level error
      if (WikiSaikouError.isBadTokenError(err) || (err as any)?.ok === false) {
        throw new WikiSaikouError(
          WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
          'Retry attempts for acquiring/using token exhausted',
          err as any
        )
      }
      // For non-retryable errors like MediaWikiApiError, keep propagation as is
      throw err
    })
  }
  postWithEditToken<T = any>(body: MwApiParams) {
    return this.postWithToken<T>('csrf', body)
  }

  // for backward compatibility
  /** @deprecated Use `this.config.baseURL` instead */
  get baseURL() {
    return this.config.baseURL
  }
  /** @deprecated Use `this.config.defaultParams` instead */
  get defaultParams(): MwApiParams {
    return this.config.defaultParams
  }
  /** @deprecated Use `this.config.fexiosConfigs` instead */
  get defaultOptions(): Partial<FexiosConfigs> {
    return this.config.fexiosConfigs
  }
  /** @deprecated Use `createFexiosSaikou` instead */
  static readonly createRequestHandler = createFexiosSaikou
  /** @deprecated Use `this.getToken` instead */
  token = this.getToken
}

// re-export for library users
export * from './models/errors.js'
export * from './models/FexiosSaikou.js'
export * from './models/MwParamNormalizer.js'
export * from '@/types.js'

// for backward compatibility
export {
  /** @deprecated Use `WikiSaikou` instead */
  WikiSaikouCore as MwApiBase,
}
