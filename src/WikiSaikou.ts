import type {
  FexiosConfigs,
  FexiosFinalContext,
  FexiosRequestOptions,
} from 'fexios'
import { FexiosQueryBuilder } from 'fexios'
import { createFexiosSaikou, type FexiosSaikou } from './models/FexiosSaikou.js'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './models/errors.js'
import { linkAbortSignals } from './internals/abort.js'
import type { RetryDelayOption, ShouldRetryOption } from './internals/backoff.js'
import { cloneBodyWithToken } from './internals/params.js'
import {
  normalizeRetryCount,
  runWithRetryAndAbort,
  useRetry,
} from './internals/retry.js'
import { TokenManager } from './internals/token-manager.js'
import { deepMerge } from './utils/deepMerge.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import type { MwApiParams, MwApiResponse, MwTokenName } from './types.js'

export interface WikiSaikouConfig {
  /**
   * The MediaWiki API endpoint, e.g. `"https://www.mediawiki.org/w/api.php"`.
   * In MediaWiki browser pages, `baseURL` can be omitted and inferred from `window.mediaWiki`.
   */
  baseURL: string
  /**
   * Optional MediaWiki REST API endpoint.
   * When omitted, inferred from `baseURL` when possible.
   */
  restApiEndpoint?: string
  /**
   * Transport/runtime options passed to the underlying Fexios instance.
   * @default { responseType: 'json' }
   */
  fexiosConfigs: Partial<FexiosConfigs>
  /**
   * Default query parameters merged into every request.
   * @default { action: 'query', errorformat: 'plaintext', format: 'json', formatversion: 2 }
   */
  defaultParams: MwApiParams
  /**
   * When true, responses whose JSON body contains `error`/`errors` throw `MediaWikiApiError` even on HTTP 2xx.
   * @default false
   */
  throwOnApiError: boolean
  /**
   * Default maximum total attempts (initial request + retries).
   * When omitted, `get`/`post` default to `1` and `postWithToken` defaults to `3`.
   */
  retry?: number
  /** Default delay in milliseconds (or backoff callback) between retry attempts. */
  retryDelay?: RetryDelayOption
  /** Callback invoked before each scheduled retry attempt. */
  onRetry?: (error: Error, retryCount: number) => void
  /**
   * Optional predicate controlling whether a failed request should be retried.
   * By default, transport/network errors are NOT retried by the SDK.
   */
  shouldRetry?: ShouldRetryOption
}

export type WikiSaikouInitConfig = Omit<
  Partial<WikiSaikouConfig>,
  'baseURL'
> & {
  baseURL: string
}

export interface WikiSaikouRequestOptions
  extends Partial<FexiosRequestOptions> {
  /** Maximum total attempts (initial request + retries). @default 1 */
  retry?: number
  /** Delay in milliseconds (or backoff callback) between retry attempts. */
  retryDelay?: RetryDelayOption
  /** Callback invoked before each scheduled retry attempt. */
  onRetry?: (error: Error, retryCount: number) => void
  /** Predicate controlling whether a failed request should be retried. */
  shouldRetry?: ShouldRetryOption
  /** AbortSignal used to cancel both in-flight requests and retry backoff sleeps. */
  signal?: AbortSignal
}

/**
 * WikiSaikou Core class
 * @internal You **SHOULD NOT** use this class directly; use `MediaWikiApi` instead.
 */
export class WikiSaikouCore {
  readonly config: WikiSaikouConfig
  readonly version = import.meta.env.__VERSION__
  readonly request: FexiosSaikou
  private readonly tokenManager: TokenManager

  static INIT_DEFAULT_PARAMS: MwApiParams = {
    action: 'query',
    errorformat: 'plaintext',
    format: 'json',
    formatversion: 2,
  }
  static DEFAULT_CONFIGS: WikiSaikouConfig = {
    baseURL: undefined as unknown as string,
    restApiEndpoint: undefined as unknown as string,
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
    this.request = createFexiosSaikou(
      deepMerge<Partial<FexiosConfigs>>({}, config.fexiosConfigs, {
        baseURL: config.baseURL,
      })
    )
    // Single source of truth: config.fexiosConfigs IS the instance baseConfigs,
    // so runtime mutations apply to every request. Do not copy it per request.
    config.fexiosConfigs = this.request.baseConfigs
    this.tokenManager = new TokenManager(this.request)
  }

  setBaseURL(baseURL: string) {
    if (baseURL !== this.config.baseURL) {
      this.tokenManager.onBaseURLChange()
    }
    this.config.baseURL = baseURL
    this.request.baseConfigs.baseURL = baseURL
    return this
  }

  private executeActionRequest<T = any>(
    query: MwApiParams,
    options: WikiSaikouRequestOptions | undefined,
    execute: (
      opts: Partial<FexiosRequestOptions>
    ) => Promise<FexiosFinalContext<MwApiResponse<T>>>
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const {
      retry = this.config.retry ?? 1,
      retryDelay = this.config.retryDelay ?? 0,
      onRetry = this.config.onRetry,
      shouldRetry = this.config.shouldRetry,
      signal,
      abortController,
      ...fexiosOptions
    } = options || {}

    const payload = deepMerge<Partial<FexiosRequestOptions>>(
      {},
      { query },
      fexiosOptions
    )

    return runWithRetryAndAbort({
      options: payload,
      baseFetch: this.request.baseConfigs.fetch,
      signal,
      abortController,
      retryPolicy: { retry, retryDelay, onRetry, shouldRetry },
      execute,
      wrapAttempt: (attempt) => this.runRequestWithApiErrorMapping(attempt),
    })
  }

  async get<T = any>(
    query: MwApiParams,
    options?: WikiSaikouRequestOptions
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    return this.executeActionRequest(
      FexiosQueryBuilder.mergeQueries(this.config.defaultParams, query),
      options,
      (opts) => this.request.get<MwApiResponse<T>>('', opts)
    )
  }

  async post<T = any>(
    data: MwApiParams | URLSearchParams | FormData,
    options?: WikiSaikouRequestOptions
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    return this.executeActionRequest(
      this.config.defaultParams,
      options,
      (opts) => this.request.post<MwApiResponse<T>>('', data, opts)
    )
  }

  /**
   * Map MediaWiki API error payloads (both HTTP 2xx and non-2xx) into
   * `MediaWikiApiError` when `throwOnApiError` is enabled.
   */
  private async runRequestWithApiErrorMapping<T = any>(
    doRequest: () => Promise<FexiosFinalContext<MwApiResponse<T>>>
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    try {
      const res = await doRequest()
      if (this.config.throwOnApiError) {
        const errors = WikiSaikouError.extractMediaWikiApiErrors(res)
        if (errors.length > 0) {
          throw new MediaWikiApiError(errors, res)
        }
      }
      return res
    } catch (err) {
      if (MediaWikiApiError.is(err)) throw err
      if (
        this.config.throwOnApiError &&
        WikiSaikouError.includesMediaWikiApiError(err)
      ) {
        throw new MediaWikiApiError(
          WikiSaikouError.extractMediaWikiApiErrors(err),
          err as FexiosFinalContext
        )
      }
      throw err
    }
  }

  // --- Token Management ---

  get tokens() {
    return this.tokenManager.cache
  }

  private fetchTokensResponse(
    types: MwTokenName[] = ['csrf'],
    options?: WikiSaikouRequestOptions
  ) {
    this.config.fexiosConfigs.credentials = 'include'
    return this.get<{ query: { tokens: Record<MwTokenName, string> } }>(
      { action: 'query', meta: 'tokens', type: types },
      options
    )
  }

  async fetchTokens(
    types: MwTokenName[] = ['csrf'],
    options?: WikiSaikouRequestOptions
  ) {
    await this.fetchTokensResponse(types, options)
    return this.tokens
  }

  async getToken(
    type: MwTokenName = 'csrf',
    noCache = false,
    options?: { signal?: AbortSignal }
  ): Promise<string> {
    return this.tokenManager.getToken(
      type,
      noCache,
      options?.signal,
      (tokenType) => this.fetchTokensResponse([tokenType], { retry: 1 })
    )
  }

  badToken(type: MwTokenName) {
    this.tokens.delete(type)
    return this.tokens
  }

  protected clearInflightTokens() {
    this.tokenManager.clearInflight()
  }

  async postWithToken<T = any>(
    tokenType: MwTokenName,
    body: MwApiParams | URLSearchParams | FormData,
    options?: {
      tokenName?: string
      retry?: number
      retryDelay?: RetryDelayOption
      onRetry?: (error: Error, retryCount: number) => void
      shouldRetry?: ShouldRetryOption
      signal?: AbortSignal
      noCache?: boolean
      fexiosOptions?: Partial<FexiosRequestOptions>
    }
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const {
      tokenName = 'token',
      retry = this.config.retry ?? 3,
      retryDelay = this.config.retryDelay ?? 0,
      onRetry: userOnRetry = this.config.onRetry,
      shouldRetry: customShouldRetry = this.config.shouldRetry,
      signal,
      noCache = false,
      fexiosOptions,
    } = options || {}

    if (
      typeof retry === 'number' &&
      Number.isFinite(retry) &&
      Number.isInteger(retry) &&
      retry < 1
    ) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
        'The limit of the number of times to automatically re-acquire the token has been exceeded'
      )
    }

    const maxAttempts = normalizeRetryCount(retry)
    const { signal: effectiveSignal, cleanup } = linkAbortSignals(
      signal,
      fexiosOptions?.abortController?.signal
    )

    let attemptIndex = 0
    let shouldRefreshToken = noCache

    try {
      return await useRetry<FexiosFinalContext<MwApiResponse<T>>>(
        async () => {
          const token = await this.getToken(
            tokenType,
            shouldRefreshToken ||
              (attemptIndex > 0 && !this.tokens.get(tokenType)),
            { signal: effectiveSignal }
          )

          const {
            abortController: fexiosAbortController,
            ...restFexiosOptions
          } = fexiosOptions || {}

          const postOptions = deepMerge<WikiSaikouRequestOptions>(
            {},
            restFexiosOptions,
            {
              retry: 1,
              customEnv: { mwTokenName: tokenType },
            }
          )
          if (signal) postOptions.signal = signal
          if (fexiosAbortController) {
            postOptions.abortController = fexiosAbortController
          }

          const ctx = await this.post<MwApiResponse<T>>(
            cloneBodyWithToken(body, tokenName, token),
            postOptions
          )

          if (WikiSaikouError.isBadTokenError(ctx.data)) {
            throw new MediaWikiApiError(
              WikiSaikouError.extractMediaWikiApiErrors(ctx.data),
              ctx
            )
          }
          return ctx
        },
        {
          retry: maxAttempts,
          retryDelay,
          signal: effectiveSignal,
          onRetry: (error, count) => {
            attemptIndex = count + 1
            shouldRefreshToken =
              noCache || WikiSaikouError.isBadTokenError(error)
            userOnRetry?.(error, count)
          },
          shouldRetry: (error, count) =>
            WikiSaikouError.isBadTokenError(error) ||
            (customShouldRetry ? customShouldRetry(error, count) : false),
        }
      )
    } catch (err) {
      if (WikiSaikouError.isBadTokenError(err)) {
        throw new WikiSaikouError(
          WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
          'Retry attempts for acquiring/using token exhausted',
          err
        )
      }
      throw err
    } finally {
      cleanup()
    }
  }

  postWithEditToken<T = any>(
    body: MwApiParams
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    return this.postWithToken<T>('csrf', body)
  }

  // --- Deprecated Backward-Compatibility Aliases ---

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

// Re-exports for library users
export * from './models/errors.js'
export * from './models/FexiosSaikou.js'
export * from './models/MwParamNormalizer.js'
export * from './types.js'
export {
  createRetryDelay,
  defaultTransportRetryDelay,
  isRetryableTransportError,
  parseRetryAfterMs,
  type RetryDelayOption,
  type RetryDelayOptions,
  type ShouldRetryOption,
} from './internals/backoff.js'
export * from 'fexios'

export {
  /** @deprecated Use `WikiSaikouCore` instead */
  WikiSaikouCore as MwApiBase,
}
