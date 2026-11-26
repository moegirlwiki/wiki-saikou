import type {
  FexiosConfigs,
  FexiosRequestOptions,
  FexiosFinalContext,
} from 'fexios'
import { FexiosQueryBuilder } from 'fexios'
import { createFexiosSaikou, FexiosSaikou } from './models/FexiosSaikou.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import { deepMerge } from './utils/deepMerge.js'
import {
  createAbortError,
  createRetryDelay,
  defaultTransportRetryDelay,
  isRetryableTransportError,
  normalizeRetryCount,
  parseRetryAfterMs,
  raceWithSignal,
  type RetryDelayOption,
  type RetryDelayOptions,
  type ShouldRetryOption,
  useRetry,
} from './utils/useRetry.js'
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
   * MediaWiki REST API endpoint.
   *
   * If not provided, it will be inferred from `baseURL` when possible, e.g.
   * `https://example.org/w/api.php` -> `https://example.org/w/rest.php/`.
   *
   * @optional Only used by REST-related helpers.
   */
  restApiEndpoint?: string
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
  /**
   * Default maximum total attempts (initial request + retries).
   * When omitted, `get`/`post` default to `1` and `postWithToken` defaults to `3`.
   */
  retry?: number
  /**
   * Default delay in milliseconds (or backoff callback) between retry attempts.
   */
  retryDelay?: RetryDelayOption
  /**
   * Callback invoked before each scheduled retry attempt.
   */
  onRetry?: (error: Error, retryCount: number) => void
  /**
   * Optional predicate allowing callers to decide whether a failed request (e.g. network/fetch error)
   * should be retried. By default, transport/network errors are NOT retried by the SDK.
   *
   * Note: passing a transport predicate like `isRetryableTransportError` at client level
   * will also retry non-idempotent POST writes on ambiguous transport failures.
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
  /**
   * Maximum total attempts (initial request + retries).
   * @default 1
   */
  retry?: number
  /**
   * Delay in milliseconds (or backoff callback) between retry attempts.
   */
  retryDelay?: RetryDelayOption
  /**
   * Callback invoked before each scheduled retry attempt.
   */
  onRetry?: (error: Error, retryCount: number) => void
  /**
   * Predicate controlling whether a failed request should be retried.
   * By default, transport/network errors are NOT retried by the SDK.
   */
  shouldRetry?: ShouldRetryOption
  /**
   * AbortSignal used to cancel both the in-flight request (via Fexios `abortController`) and retry backoff sleeps.
   */
  signal?: AbortSignal
}

/**
 * WikiSaikou Core class
 * @internal You **SHOULD NOT** use this class directly, instead, use the `MediaWikiApi` class.
 * @author dragon-fish <dragon-fish@qq.com>
 * @license MIT
 */
export class WikiSaikouCore {
  readonly config: WikiSaikouConfig
  readonly version = import.meta.env.__VERSION__
  readonly request: FexiosSaikou
  private inflightTokenRequests = new Map<MwTokenName, Promise<string>>()
  private inflightForcedTokenRequests = new Map<MwTokenName, Promise<string>>()

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
    this.request = createFexiosSaikou(config.baseURL)
  }

  setBaseURL(baseURL: string) {
    this.config.baseURL = baseURL
    this.request.baseConfigs.baseURL = baseURL
    return this
  }

  private withResponseTracking(
    options: Partial<FexiosRequestOptions>,
    onResponse: (res: Response) => void
  ): Partial<FexiosRequestOptions> {
    const baseFetch = options.fetch ?? globalThis.fetch
    if (typeof baseFetch !== 'function') {
      return options
    }
    return {
      ...options,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await baseFetch(input, init)
        onResponse(res)
        return res
      },
    }
  }

  private withLinkedAbortController<T>(
    options: Partial<FexiosRequestOptions>,
    signal: AbortSignal | undefined,
    existingController: AbortController | undefined,
    fn: (opts: Partial<FexiosRequestOptions>) => Promise<T>
  ): Promise<T> {
    if (!signal) {
      return fn(
        existingController ? { ...options, abortController: existingController } : options
      )
    }
    if (signal.aborted) {
      existingController?.abort(signal.reason)
      return Promise.reject(createAbortError(signal))
    }
    const targetController = existingController ?? new AbortController()
    const onAbort = () => targetController.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    return fn({ ...options, abortController: targetController }).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  }

  private runWithRetry<T = any>(
    doRequest: () => Promise<FexiosFinalContext<MwApiResponse<T>>>,
    retryOptions: {
      retry?: number
      retryDelay?: RetryDelayOption
      onRetry?: (error: Error, retryCount: number) => void
      shouldRetry?: ShouldRetryOption
      signal?: AbortSignal
    }
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const {
      retry = this.config.retry ?? 1,
      retryDelay = this.config.retryDelay ?? 0,
      onRetry = this.config.onRetry,
      shouldRetry = this.config.shouldRetry,
      signal,
    } = retryOptions
    let maxAttempts: number
    try {
      maxAttempts = normalizeRetryCount(retry)
    } catch (err) {
      return Promise.reject(err)
    }
    if (maxAttempts <= 1 || !shouldRetry) {
      if (signal?.aborted) {
        return Promise.reject(createAbortError(signal))
      }
      return this.runRequestWithApiErrorMapping(doRequest)
    }
    return useRetry(() => this.runRequestWithApiErrorMapping(doRequest), {
      retry: maxAttempts,
      retryDelay,
      onRetry,
      shouldRetry,
      signal,
    })
  }

  async get<T = any>(
    query: MwApiParams,
    options?: WikiSaikouRequestOptions
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const {
      retry,
      retryDelay,
      onRetry,
      shouldRetry,
      signal,
      abortController,
      ...fexiosOptions
    } = options || {}
    const payload = deepMerge<Partial<FexiosRequestOptions>>(
      {},
      this.config.fexiosConfigs as Partial<FexiosRequestOptions>,
      {
        query: FexiosQueryBuilder.mergeQueries(
          this.config.defaultParams,
          query
        ),
      },
      fexiosOptions
    )
    return this.runWithRetry(
      () => {
        let lastResponse: Response | undefined
        return this.withLinkedAbortController(
          this.withResponseTracking(payload, (r) => {
            lastResponse = r
          }),
          signal,
          abortController,
          (opts) =>
            this.request.get<MwApiResponse<T>>('', opts).catch((err) => {
              if (
                lastResponse &&
                err &&
                typeof err === 'object' &&
                !err.rawResponse
              ) {
                err.rawResponse = lastResponse
              }
              throw err
            })
        )
      },
      { retry, retryDelay, onRetry, shouldRetry, signal }
    )
  }
  async post<T = any>(
    data: MwApiParams | URLSearchParams | FormData,
    options?: WikiSaikouRequestOptions
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const {
      retry,
      retryDelay,
      onRetry,
      shouldRetry,
      signal,
      abortController,
      ...fexiosOptions
    } = options || {}
    const payload = deepMerge<Partial<FexiosRequestOptions>>(
      {},
      this.config.fexiosConfigs as Partial<FexiosRequestOptions>,
      {
        query: this.config.defaultParams,
      },
      fexiosOptions
    )
    return this.runWithRetry(
      () => {
        let lastResponse: Response | undefined
        return this.withLinkedAbortController(
          this.withResponseTracking(payload, (r) => {
            lastResponse = r
          }),
          signal,
          abortController,
          (opts) =>
            this.request.post<MwApiResponse<T>>('', data, opts).catch((err) => {
              if (
                lastResponse &&
                err &&
                typeof err === 'object' &&
                !err.rawResponse
              ) {
                err.rawResponse = lastResponse
              }
              throw err
            })
        )
      },
      { retry, retryDelay, onRetry, shouldRetry, signal }
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
      if (MediaWikiApiError.is(err)) {
        throw err
      }
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

  private throwIfApiError(ctxOrData?: any) {
    const errors = WikiSaikouError.extractMediaWikiApiErrors(ctxOrData)
    if (errors.length > 0) {
      throw new MediaWikiApiError(errors, ctxOrData)
    }
  }
  private handleApiResponse<T = any>(
    res: FexiosFinalContext<MwApiResponse<T>>
  ) {
    if (this.config.throwOnApiError) {
      this.throwIfApiError(res)
    }
    return res
  }

  /** Token Handler */
  get tokens() {
    return this.request._tokens
  }
  async fetchTokens(
    types: MwTokenName[] = ['csrf'],
    options?: WikiSaikouRequestOptions
  ) {
    this.config.fexiosConfigs.credentials = 'include'
    await this.get<{
      query: { tokens: Record<MwTokenName, string> }
    }>(
      {
        action: 'query',
        meta: 'tokens',
        type: types,
      },
      options
    )
    return this.tokens
  }
  async getToken(
    type: MwTokenName = 'csrf',
    noCache = false,
    options?: { signal?: AbortSignal }
  ) {
    const signal = options?.signal
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal))
    }

    if (!noCache) {
      const cached = this.tokens.get(type)
      if (cached) {
        return cached
      }
      const inflight =
        this.inflightTokenRequests.get(type) ??
        this.inflightForcedTokenRequests.get(type)
      if (inflight) {
        return raceWithSignal(inflight, signal)
      }
    } else {
      const inflightForced = this.inflightForcedTokenRequests.get(type)
      if (inflightForced) {
        return raceWithSignal(inflightForced, signal)
      }
    }

    if (noCache) {
      this.tokens.delete(type)
    }
    const map = noCache
      ? this.inflightForcedTokenRequests
      : this.inflightTokenRequests
    const pending = this.fetchTokens([type], { retry: 1 })
      .then(() => this.tokens.get(type)!)
      .finally(() => {
        if (map.get(type) === pending) {
          map.delete(type)
        }
      })
    map.set(type, pending)
    return raceWithSignal(pending, signal)
  }
  badToken(type: MwTokenName) {
    this.tokens.delete(type)
    return this.tokens
  }

  private attachTokenToBody(
    body: MwApiParams | URLSearchParams | FormData,
    tokenName: string,
    token: string
  ): MwApiParams | URLSearchParams | FormData {
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const copy = new FormData()
      body.forEach((value, key) => {
        copy.append(key, value)
      })
      copy.set(tokenName, token)
      return copy
    }
    if (body instanceof URLSearchParams) {
      const copy = new URLSearchParams(body)
      copy.set(tokenName, token)
      return copy
    }
    return {
      [tokenName]: token,
      ...body,
    }
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

    let attemptIndex = 0
    let shouldRefreshToken = noCache
    return useRetry<FexiosFinalContext<MwApiResponse<T>>>(
      async () => {
        const token = await this.getToken(
          tokenType,
          shouldRefreshToken || (attemptIndex > 0 && !this.tokens.get(tokenType)),
          { signal }
        )

        const {
          abortController: fexiosAbortController,
          ...restFexiosOptions
        } = fexiosOptions || {}
        const postOptions = deepMerge<WikiSaikouRequestOptions>(
          restFexiosOptions,
          {
            retry: 1,
            customEnv: {
              mwTokenName: tokenType,
            },
          }
        )
        if (signal) {
          postOptions.signal = signal
        }
        if (fexiosAbortController) {
          postOptions.abortController = fexiosAbortController
        }

        const ctx = await this.post<MwApiResponse<T>>(
          this.attachTokenToBody(body, tokenName, token),
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
        signal,
        onRetry: (error, count) => {
          attemptIndex = count + 1
          shouldRefreshToken =
            noCache || WikiSaikouError.isBadTokenError(error)
          userOnRetry?.(error, count)
        },
        shouldRetry: (error, count) => {
          if (WikiSaikouError.isBadTokenError(error)) {
            return true
          }
          return customShouldRetry ? customShouldRetry(error, count) : false
        },
      }
    ).catch((err) => {
      // Map exhausted retry of badtoken errors into SDK-level error
      if (WikiSaikouError.isBadTokenError(err)) {
        throw new WikiSaikouError(
          WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
          'Retry attempts for acquiring/using token exhausted',
          err as any
        )
      }
      // Propagate transport, MediaWikiApiError, or other errors untouched
      throw err
    })
  }
  postWithEditToken<T = any>(
    body: MwApiParams
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
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
export * from './types.js'
export {
  createRetryDelay,
  defaultTransportRetryDelay,
  isRetryableTransportError,
  parseRetryAfterMs,
  type RetryDelayOption,
  type RetryDelayOptions,
  type ShouldRetryOption,
} from './utils/useRetry.js'
export * from 'fexios'

// for backward compatibility
export {
  /** @deprecated Use `WikiSaikou` instead */
  WikiSaikouCore as MwApiBase,
}
