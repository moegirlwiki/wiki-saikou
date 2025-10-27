import {
  Fexios,
  FexiosConfigs,
  FexiosRequestOptions,
  FexiosFinalContext,
  checkIsPlainObject,
} from 'fexios'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import { deepMerge } from './utils/deepMerge.js'
import { useRetry } from './utils/useRetry.js'

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
  readonly request: Fexios
  private tokens = new Map<string, string>()

  // for backward compatibility
  /** @deprecated Use `config.baseURL` instead */
  get baseURL() {
    return this.config.baseURL
  }
  /** @deprecated Use `config.defaultParams` instead */
  get defaultParams(): MwApiParams {
    return this.config.defaultParams
  }
  /** @deprecated Use `config.fexiosConfigs` instead */
  get defaultOptions(): Partial<FexiosConfigs> {
    return this.config.fexiosConfigs
  }

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
    this.request = WikiSaikouCore.createRequestHandler(config.baseURL)
  }

  setBaseURL(baseURL: string) {
    this.config.baseURL = baseURL
    this.request.baseConfigs.baseURL = baseURL
    return this
  }

  static normalizeParamValue(item: any): string | Blob | undefined {
    if (Array.isArray(item)) {
      return item.join('|')
    } else if (typeof item === 'boolean' || item === null) {
      return item ? '1' : undefined
    } else if (typeof item === 'number') {
      return '' + item
    } else {
      return item
    }
  }
  normalizeParamValue = WikiSaikouCore.normalizeParamValue

  static normalizeBody(body: any): FormData | undefined {
    const isFormLike = (body: any): body is URLSearchParams | FormData =>
      body && (body instanceof URLSearchParams || body instanceof FormData)

    if (body === void 0 || body === null) {
      return void 0
    }

    const formData = new FormData()

    if (isFormLike(body)) {
      body.forEach((value, key) => {
        const data = WikiSaikouCore.normalizeParamValue(value)
        if (data !== null && data !== void 0) {
          formData.append(key, data as any)
        }
      })
      return formData
    }

    if (checkIsPlainObject(body)) {
      Object.entries(body).forEach(([key, value]) => {
        const data = WikiSaikouCore.normalizeParamValue(value)
        if (data !== null && data !== void 0) {
          formData.append(key, data as any)
        }
      })
      return formData
    }

    return void 0
  }
  normalizeBody = WikiSaikouCore.normalizeBody

  static createRequestHandler(baseURL: string) {
    const instance = new Fexios({
      baseURL,
      responseType: 'json',
    })

    // Adjust request body for POST requests
    instance.on('beforeInit', (ctx) => {
      if (ctx.method?.toLowerCase() !== 'post') {
        return ctx
      }

      if (ctx.body === void 0 || ctx.body === null) {
        ctx.body = void 0
        return ctx
      }

      const body = (ctx.body = WikiSaikouCore.normalizeBody(ctx.body)!)

      // Remove duplicate params: prefer body over query for these keys
      const query = new URLSearchParams(ctx.query as any)
      if (body.has('format')) {
        query.delete('format')
      }
      if (body.has('formatversion')) {
        query.delete('formatversion')
      }
      if (body.has('action')) {
        query.delete('action')
      }
      // `origin` must be in query due to CORS requirements
      if (body.has('origin')) {
        query.set('origin', '' + body.get('origin'))
        body.delete('origin')
      }
      ctx.query = Object.fromEntries(query.entries())

      return ctx
    })

    // Normalize query into FormData-like object
    instance.on('beforeInit', (ctx) => {
      ctx.query = WikiSaikouCore.normalizeBody(ctx.query) || {}
      return ctx
    })

    // Adjust origin parameter and CORS related runtime configs
    instance.on('beforeRequest', (ctx) => {
      const url = new URL(ctx.url!)
      const searchParams = url.searchParams
      // Automatically add/remove origin based on current location and baseURL
      if (globalThis.location) {
        if (
          !searchParams.has('origin') &&
          location.origin !== new URL(baseURL).origin
        ) {
          searchParams.set('origin', location.origin)
          instance.baseConfigs.credentials = 'include'
          instance.baseConfigs.mode = 'cors'
        } else if (location.origin === new URL(baseURL).origin) {
          searchParams.delete('origin')
          instance.baseConfigs.credentials = undefined
          instance.baseConfigs.mode = undefined
        }
      }

      if (url.searchParams.has('origin')) {
        const origin = encodeURIComponent(
          url.searchParams.get('origin') || ''
        ).replace(/\./g, '%2E')
        ctx.query = {}
        url.searchParams.delete('origin')
        ctx.url = `${url}${url.search ? '&' : '?'}origin=${origin}`
      }
      return ctx
    })

    return instance
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
        WikiSaikouCore.includesMediaWikiApiError(err)
      ) {
        throw new MediaWikiApiError(
          WikiSaikouCore.extractMediaWikiApiErrors(err),
          err as any
        )
      }
      throw err as any
    }
  }

  private throwIfApiError(data?: any) {
    const errors = WikiSaikouCore.extractMediaWikiApiErrors(data)
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

  async getUserInfo() {
    const { data } = await this.get<{
      query: {
        userinfo: {
          id: number
          name: string
          groups: string[]
          rights: string[]
          blockid?: number
          blockedby?: string
          blockedbyid?: number
          blockreason?: string
          blockexpiry?: string
          blockedtimestamp?: string
        }
      }
    }>({
      action: 'query',
      meta: 'userinfo',
      uiprop: ['groups', 'rights', 'blockinfo'],
    })
    return data?.query?.userinfo
  }

  /** Token Handler */
  async fetchTokens(types: MwTokenName[] = ['csrf']) {
    this.config.fexiosConfigs.credentials = 'include'
    const { data } = await this.get<{
      query: { tokens: Record<MwTokenName, string> }
    }>({
      action: 'query',
      meta: 'tokens',
      type: types,
    })
    Object.entries(data.query.tokens).forEach(([type, token]) => {
      this.tokens.set(type, token)
    })
    return this.tokens
  }
  async getToken(type: MwTokenName = 'csrf', noCache = false) {
    if (!this.tokens.get(`${type}token`) || noCache) {
      this.tokens.delete(`${type}token`)
      await this.fetchTokens([type])
    }
    return this.tokens.get(`${type}token`)!
  }
  /** @deprecated Use `getToken` instead */
  token = this.getToken
  badToken(type: MwTokenName) {
    this.tokens.delete(`${type}token`)
    return this.tokens
  }

  async postWithToken<T = any>(
    tokenType: MwTokenName,
    body: MwApiParams,
    options?: {
      tokenName?: string
      retry?: number
      noCache?: boolean
    }
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const { tokenName = 'token', retry = 3, noCache = false } = options || {}

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
            undefined
          )

          if (WikiSaikouCore.isBadTokenError(ctx.data)) {
            this.badToken(tokenType)
            throw ctx
          }
          return ctx
        } catch (err: any) {
          if (WikiSaikouCore.isBadTokenError(err) || err?.ok === false) {
            this.badToken(tokenType)
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
          WikiSaikouCore.isBadTokenError(error) || (error as any)?.ok === false,
      }
    ).catch((err) => {
      // Map exhausted retry of retryable errors into SDK-level error
      if (WikiSaikouCore.isBadTokenError(err) || (err as any)?.ok === false) {
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

  private static extractResponseDataFromAny<T = any>(
    data?: any
  ): T | undefined {
    return data?.response?.data || data?.data || data || undefined
  }

  static includesMediaWikiApiError(data?: any) {
    return WikiSaikouCore.extractMediaWikiApiErrors(data).length > 0
  }
  includesMediaWikiApiError = WikiSaikouCore.includesMediaWikiApiError

  static extractMediaWikiApiErrors(data?: any): MwApiResponseError[] {
    const r = WikiSaikouCore.extractResponseDataFromAny<MwApiResponse>(data)
    if (typeof r !== 'object' || r === null) {
      return []
    }
    const error = r?.error
    const errors = r?.errors
    const result: MwApiResponseError[] = []
    if (error) {
      result.push(error)
    }
    if (Array.isArray(errors)) {
      result.push(...errors)
    }
    return result
  }
  extractMediaWikiApiErrors = WikiSaikouCore.extractMediaWikiApiErrors

  static isBadTokenError(data?: any): boolean {
    if (MediaWikiApiError.is(data)) {
      return data.isBadTokenError()
    } else {
      const errors = WikiSaikouCore.extractMediaWikiApiErrors(data)
      return new MediaWikiApiError(errors).isBadTokenError()
    }
  }
  isBadTokenError = WikiSaikouCore.isBadTokenError
}

export {
  /** @deprecated Use `WikiSaikou` instead */
  WikiSaikouCore as MwApiBase,
}

// Errors
export enum WikiSaikouErrorCode {
  HTTP_ERROR = 'HTTP_ERROR',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_RETRY_LIMIT_EXCEEDED = 'LOGIN_RETRY_LIMIT_EXCEEDED',
  TOKEN_RETRY_LIMIT_EXCEEDED = 'TOKEN_RETRY_LIMIT_EXCEEDED',
}
/**
 * WikiSaikou Error:
 * - Transport/network failures (e.g., fetch failure, HTTP layer issues)
 * - SDK behavioral errors such as exhausted internal retries or misconfigurations
 * Note: When MediaWiki API responds with JSON containing error/errors, a MediaWikiApiError should be thrown instead
 */
export class WikiSaikouError extends Error {
  readonly name = 'WikiSaikouError'
  constructor(
    readonly code: WikiSaikouErrorCode,
    readonly message: string = '',
    readonly cause?: FexiosFinalContext
  ) {
    super()
  }
  static is(data?: any, code?: WikiSaikouErrorCode): data is WikiSaikouError {
    return data instanceof this && (code === undefined || data.code === code)
  }
}
/**
 * Server-side (MediaWiki API) business error:
 * - fetch succeeded but JSON includes `error` or `errors.length > 0`
 * - Special states (e.g., login NeedToken/WrongToken) are also considered API-side errors
 * Note: network/retry issues belong to WikiSaikouError, not this class
 */
export class MediaWikiApiError extends Error {
  readonly name = 'MediaWikiApiError'
  readonly code: string
  constructor(
    readonly errors: MwApiResponseError[],
    readonly cause?: FexiosFinalContext
  ) {
    super()
    this.message = errors.map((error) => error.info).join('\n')
    this.code = this.isBadTokenError()
      ? 'badtoken'
      : this.errors[0]?.code || 'Unknown Error'
  }
  isBadTokenError() {
    return (
      this.errors.some((error) => error.code === 'badtoken') ||
      ['NeedToken', 'WrongToken'].includes(this.cause?.data?.login?.result)
    )
  }
  toString() {
    return `[${this.name} ${this.code}]`
  }
  static is(data?: any): data is MediaWikiApiError {
    return data instanceof this
  }
}

// Types
export type MwApiParams = Record<
  string,
  string | number | string[] | undefined | boolean | File | Blob
>
export type MwTokenName =
  | 'createaccount'
  | 'csrf'
  | 'login'
  | 'patrol'
  | 'rollback'
  | 'userrights'
  | 'watch'
export type MwApiResponse<T = any> = T & {
  batchcomplete?: string
  continue?: {
    [key: string]: string
    continue: string
  }
  limits?: Record<string, number>
  error?: MwApiResponseError
  errors?: MwApiResponseError[]
  warnings?: Record<string, { warnings: string }>
}
export interface MwApiResponseError {
  code: string
  info: string
  docref?: string
}
