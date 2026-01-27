import type {
  FexiosConfigs,
  FexiosFinalContext,
  FexiosMethods,
  FexiosRequestOptions,
} from 'fexios'
import { deepMerge, Fexios } from 'fexios'
import { WikiSaikouError, WikiSaikouErrorCode } from './models/errors.js'

export interface MediaWikiRestApiConfig {
  /**
   * MediaWiki REST API endpoint base URL.
   *
   * Accepts:
   * - `https://example.org/w/rest.php`
   * - `https://example.org/w/rest.php/`
   *
   * It will be normalized to always end with `/`, and query/hash will be stripped
   * to avoid leaking into requests.
   */
  baseURL?: string
  /**
   * Transport/runtime options passed to the underlying Fexios instance (headers, fetch, credentials, etc.).
   *
   * Notes:
   * - For REST, the default response parsing should be auto-detected (no forced `responseType`).
   * - If you explicitly set `responseType` here (even `undefined`), it will be honored.
   */
  fexiosConfigs?: Partial<FexiosConfigs>
}

export type MediaWikiRestApiInitConfig = MediaWikiRestApiConfig

export type MediaWikiRestRequestOptions = Partial<
  FexiosRequestOptions & { pathParams?: Record<string, string> }
>

/**
 * MediaWikiRestApi
 *
 * A standalone REST (rest.php) client. It does NOT extend `WikiSaikouCore`,
 * because REST and Action API have almost no reusable request semantics.
 */
export class MediaWikiRestApi {
  readonly config: Required<MediaWikiRestApiConfig>

  /** Underlying HTTP client (Fexios). */
  readonly http: Fexios

  constructor(config: MediaWikiRestApiInitConfig) {
    const fexiosConfigs = (config.fexiosConfigs || {}) as Partial<FexiosConfigs>
    const baseURL =
      config.baseURL ??
      (typeof window !== 'undefined'
        ? this.inferRestBaseURLFromMediaWikiConfig()
        : undefined)

    if (!baseURL) {
      // Node: must provide baseURL. Browser: we already tried to infer it.
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        typeof window === 'undefined'
          ? 'Missing "baseURL" in Node.js environment. Please pass an absolute REST endpoint base URL.'
          : 'Missing "baseURL" and unable to infer it from MediaWiki runtime config.'
      )
    }
    this.config = {
      baseURL,
      fexiosConfigs,
    }

    const normalizedRestEndpoint = this.normalizeRestBaseURL(
      this.config.baseURL
    )

    // Prefer creating a dedicated plain Fexios instance for REST (no MW-specific hooks).
    this.http = new Fexios(
      deepMerge<Partial<FexiosConfigs>>({}, fexiosConfigs, {
        baseURL: normalizedRestEndpoint,
      }) as any
    )

    // Default behavior: auto-detect response type (important for non-JSON endpoints like HTML).
    // Only honor responseType when user explicitly provides it.
    if (!Object.prototype.hasOwnProperty.call(fexiosConfigs, 'responseType')) {
      delete (this.http.baseConfigs as any).responseType
    } else {
      ;(this.http.baseConfigs as any).responseType = (
        fexiosConfigs as any
      ).responseType
    }
  }

  /**
   * Low-level request to REST endpoint.
   *
   * @example
   * ```ts
   * const res = await api.request('GET', '/v1/page/{title}', {
   *   pathParams: { title: 'Main Page' },
   *   query: { redirect: 'true' },
   * })
   * console.log(res.data)
   * ```
   */
  async request<T = any>(
    method: FexiosMethods,
    path: string,
    options?: MediaWikiRestRequestOptions
  ): Promise<FexiosFinalContext<T>> {
    const { pathParams, ...restOptions } = options || {}
    const finalPath = this.resolvePath(path, pathParams)
    const url = this.buildRestUrl(finalPath)

    // Note: deepMerge won't override with `undefined`, so we must handle responseType specially:
    // - default: auto-detect (remove responseType)
    // - if user explicitly provides responseType (even undefined), honor it
    const merged = deepMerge<Partial<FexiosRequestOptions>>(
      {},
      this.config.fexiosConfigs as Partial<FexiosRequestOptions>,
      restOptions
    ) as any

    const hasRequestResponseType = Object.prototype.hasOwnProperty.call(
      restOptions,
      'responseType'
    )
    const hasClientResponseType = Object.prototype.hasOwnProperty.call(
      this.config.fexiosConfigs,
      'responseType'
    )

    if (!hasRequestResponseType && !hasClientResponseType) {
      delete merged.responseType
    } else if (hasRequestResponseType) {
      merged.responseType = (restOptions as any).responseType
    }

    return await this.http.request<T>({
      ...merged,
      url,
      method,
    })
  }

  async get<T = any>(path: string, options?: MediaWikiRestRequestOptions) {
    return await this.request<T>('GET', path, options)
  }

  async delete<T = any>(path: string, options?: MediaWikiRestRequestOptions) {
    return await this.request<T>('DELETE', path, options)
  }

  async post<T = any>(
    path: string,
    body?: any,
    options?: MediaWikiRestRequestOptions
  ) {
    return await this.request<T>('POST', path, {
      ...options,
      body,
    })
  }

  async put<T = any>(
    path: string,
    body?: any,
    options?: MediaWikiRestRequestOptions
  ) {
    return await this.request<T>('PUT', path, {
      ...options,
      body,
    })
  }

  async patch<T = any>(
    path: string,
    body?: any,
    options?: MediaWikiRestRequestOptions
  ) {
    return await this.request<T>('PATCH', path, {
      ...options,
      body,
    })
  }

  private resolvePath(
    path: string,
    pathParams?: Record<string, string>
  ): string {
    // /v1/page/{title} + { title: 'Main Page' } = /v1/page/Main%20Page
    if (pathParams) {
      Object.entries(pathParams).forEach(([key, value]) => {
        path = path.replaceAll(`{${key}}`, encodeURIComponent(value))
      })
    }
    // Only treat single-level `{...}` as placeholders.
    if (/\{[^{}]+\}/.test(path)) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_PATH,
        `The REST path "${path}" is invalid, some parameters are not provided`
      )
    }
    return path
  }

  private buildRestUrl(path: string): string {
    // Absolute URL: send as-is
    if (/^https?:\/\//i.test(path)) {
      return path
    }
    // Keep it relative to `this.http.baseConfigs.baseURL`.
    // IMPORTANT: Do not start with `/`, otherwise URL resolution will drop `/rest.php/`.
    return path.replace(/^\//, '')
  }

  private normalizeEndpointNoSearchHash(endpoint: string): string {
    try {
      const u = new URL(
        endpoint,
        globalThis.location?.href || 'https://example.invalid/'
      )
      u.search = ''
      u.hash = ''
      return u.toString()
    } catch {
      // If it's not a valid URL string, return as-is.
      return endpoint
    }
  }

  private normalizeRestBaseURL(baseURL: string): string {
    const stripped = this.normalizeEndpointNoSearchHash(baseURL)
    // Must be an absolute URL string, otherwise we can't safely use it as baseURL in Node.
    if (!/^https?:\/\//i.test(stripped)) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        `Invalid REST baseURL "${baseURL}". Please pass an absolute URL like "https://example.org/w/rest.php/".`
      )
    }
    return /\/$/.test(stripped) ? stripped : stripped + '/'
  }

  private inferRestBaseURLFromMediaWikiConfig(): string | undefined {
    try {
      const { wgServer, wgScriptPath } =
        (window as any).mediaWiki?.config?.get(['wgServer', 'wgScriptPath']) ||
        {}
      if (typeof wgServer !== 'string' || typeof wgScriptPath !== 'string') {
        return undefined
      }
      let url = `${wgServer}${wgScriptPath}/rest.php/`
      if (url.startsWith('//')) {
        url = `${window.location.protocol}${url}`
      }
      return url
    } catch {
      return undefined
    }
  }
}

export { MediaWikiRestApi as RestSaikou }
