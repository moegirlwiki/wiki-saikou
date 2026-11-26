import type {
  FexiosConfigs,
  FexiosFinalContext,
  FexiosMethods,
  FexiosRequestOptions,
} from 'fexios'
import { deepMerge, Fexios } from 'fexios'
import type { RetryDelayOption, ShouldRetryOption } from './internals/backoff.js'
import { inferMediaWikiEndpoint } from './internals/params.js'
import { runWithRetryAndAbort } from './internals/retry.js'
import { WikiSaikouError, WikiSaikouErrorCode } from './models/errors.js'

export interface MediaWikiRestApiConfig {
  /**
   * MediaWiki REST API endpoint base URL (normalized to end with `/`, query/hash stripped).
   * Accepts `https://example.org/w/rest.php` or `https://example.org/w/rest.php/`.
   */
  baseURL?: string
  /**
   * Transport/runtime options passed to the underlying Fexios instance.
   * By default, response parsing is auto-detected unless `responseType` is explicitly set.
   */
  fexiosConfigs?: Partial<FexiosConfigs>
  /** Default maximum total attempts (initial request + retries). @default 1 */
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

export type MediaWikiRestApiInitConfig = MediaWikiRestApiConfig

export type MediaWikiRestRequestOptions = Partial<
  FexiosRequestOptions & {
    pathParams?: Record<string, string>
    retry?: number
    retryDelay?: RetryDelayOption
    onRetry?: (error: Error, retryCount: number) => void
    shouldRetry?: ShouldRetryOption
    signal?: AbortSignal
  }
>

const hasOwn = (obj: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(obj, key)

/**
 * Standalone MediaWiki REST (`rest.php`) client.
 * Does not extend `WikiSaikouCore` because REST and Action API have distinct semantics.
 */
export class MediaWikiRestApi {
  readonly config: Required<
    Pick<MediaWikiRestApiConfig, 'baseURL' | 'fexiosConfigs'>
  > &
    Omit<MediaWikiRestApiConfig, 'baseURL' | 'fexiosConfigs'>

  /** Underlying HTTP client (Fexios). */
  readonly http: Fexios

  constructor(config: MediaWikiRestApiInitConfig) {
    const fexiosConfigs: Partial<FexiosConfigs> = config.fexiosConfigs || {}
    const baseURL = config.baseURL ?? inferMediaWikiEndpoint('rest.php/')
    const normalizedRestEndpoint = this.normalizeRestBaseURL(baseURL)

    this.config = {
      baseURL: normalizedRestEndpoint,
      fexiosConfigs,
      retry: config.retry,
      retryDelay: config.retryDelay,
      onRetry: config.onRetry,
      shouldRetry: config.shouldRetry,
    }

    this.http = new Fexios(
      deepMerge<Partial<FexiosConfigs>>({}, fexiosConfigs, {
        baseURL: normalizedRestEndpoint,
      })
    )

    // Auto-detect responseType by default; only honor it when explicitly provided.
    if (!hasOwn(fexiosConfigs, 'responseType')) {
      delete this.http.baseConfigs.responseType
    } else {
      this.http.baseConfigs.responseType = fexiosConfigs.responseType
    }
  }

  /**
   * Low-level request to REST endpoint.
   */
  async request<T = any>(
    method: FexiosMethods,
    path: string,
    options?: MediaWikiRestRequestOptions
  ): Promise<FexiosFinalContext<T>> {
    const {
      pathParams,
      retry = this.config.retry ?? 1,
      retryDelay = this.config.retryDelay ?? 0,
      onRetry = this.config.onRetry,
      shouldRetry = this.config.shouldRetry,
      signal,
      abortController,
      ...restOptions
    } = options || {}

    const finalPath = this.resolvePath(path, pathParams)
    const url = /^https?:\/\//i.test(finalPath)
      ? finalPath
      : finalPath.replace(/^\//, '')

    const merged = deepMerge<Partial<FexiosRequestOptions>>(
      {},
      this.config.fexiosConfigs as Partial<FexiosRequestOptions>,
      restOptions
    )

    // deepMerge skips `undefined`, so handle explicit responseType specially
    const hasRequestResponseType = hasOwn(restOptions, 'responseType')
    const hasClientResponseType = hasOwn(
      this.config.fexiosConfigs,
      'responseType'
    )
    if (!hasRequestResponseType && !hasClientResponseType) {
      delete merged.responseType
    } else if (hasRequestResponseType) {
      merged.responseType = restOptions.responseType
    }

    return runWithRetryAndAbort({
      options: merged,
      baseFetch: this.http.baseConfigs.fetch,
      signal,
      abortController,
      retryPolicy: { retry, retryDelay, onRetry, shouldRetry },
      execute: (opts) => this.http.request<T>({ ...opts, url, method }),
    })
  }

  async get<T = any>(path: string, options?: MediaWikiRestRequestOptions) {
    return this.request<T>('GET', path, options)
  }

  async delete<T = any>(path: string, options?: MediaWikiRestRequestOptions) {
    return this.request<T>('DELETE', path, options)
  }

  async post<T = any>(
    path: string,
    body?: unknown,
    options?: MediaWikiRestRequestOptions
  ) {
    return this.request<T>('POST', path, {
      ...options,
      body: body as FexiosRequestOptions['body'],
    })
  }

  async put<T = any>(
    path: string,
    body?: unknown,
    options?: MediaWikiRestRequestOptions
  ) {
    return this.request<T>('PUT', path, {
      ...options,
      body: body as FexiosRequestOptions['body'],
    })
  }

  async patch<T = any>(
    path: string,
    body?: unknown,
    options?: MediaWikiRestRequestOptions
  ) {
    return this.request<T>('PATCH', path, {
      ...options,
      body: body as FexiosRequestOptions['body'],
    })
  }

  private resolvePath(
    path: string,
    pathParams?: Record<string, string>
  ): string {
    const requiredKeys = Array.from(path.matchAll(/\{([^{}]+)\}/g), (m) => m[1])
    const provided = new Set(Object.keys(pathParams || {}))
    const missing = requiredKeys.filter((k) => !provided.has(k))

    if (missing.length) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_PATH,
        `The REST path "${path}" is invalid, missing parameters: ${missing.join(', ')}`
      )
    }

    if (pathParams) {
      for (const [key, value] of Object.entries(pathParams)) {
        path = path.replaceAll(`{${key}}`, encodeURIComponent(value))
      }
    }
    return path
  }

  private normalizeRestBaseURL(baseURL?: string): string {
    if (typeof baseURL !== 'string' || baseURL.trim() === '') {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        'Missing REST baseURL. Please pass an absolute URL like "https://example.org/w/rest.php/".'
      )
    }

    const raw = baseURL.trim()
    const locationProtocol = (
      globalThis as { location?: { protocol?: unknown } }
    ).location?.protocol

    let absoluteInput = raw
    if (raw.startsWith('//')) {
      if (typeof locationProtocol !== 'string' || !locationProtocol) {
        throw new WikiSaikouError(
          WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
          `Invalid REST baseURL "${baseURL}". Protocol-relative URL is only supported in browser environments. Please pass an absolute URL like "https://example.org/w/rest.php/".`
        )
      }
      absoluteInput = `${locationProtocol}${raw}`
    } else if (!/^https?:\/\//i.test(raw)) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        `Invalid REST baseURL "${baseURL}". Please pass an absolute URL like "https://example.org/w/rest.php/".`
      )
    }

    let u: URL
    try {
      u = new URL(absoluteInput)
    } catch {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        `Invalid REST baseURL "${baseURL}". Please pass an absolute URL like "https://example.org/w/rest.php/".`
      )
    }

    if (!/^https?:$/i.test(u.protocol)) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        `Invalid REST baseURL "${baseURL}". Please pass an absolute HTTP(S) URL.`
      )
    }

    u.search = ''
    u.hash = ''
    const href = u.toString()
    return href.endsWith('/') ? href : `${href}/`
  }
}

export { MediaWikiRestApi as RestSaikou }
