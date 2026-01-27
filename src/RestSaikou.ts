import type {
  FexiosFinalContext,
  FexiosMethods,
  FexiosRequestOptions,
} from 'fexios'
import {
  deepMerge,
  WikiSaikouCore,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './WikiSaikou.js'

export class MediaWikiRestApi extends WikiSaikouCore {
  /**
   * RESTful API endpoint wrapper
   * @param method - The HTTP method to use
   * @param path - The path of the RESTful API endpoint
   * @param options - The options for the request
   * @returns The response from the RESTful API endpoint
   *
   * @example
   * ```
   * const response = await api.rest('GET', '/v1/page/{title}', { pathParams: { title: 'Main Page' } })
   * console.log(response.data)
   * ```
   */
  async rest<T = any>(
    method: FexiosMethods,
    path: string,
    options?: Partial<
      FexiosRequestOptions & { pathParams?: Record<string, string> }
    >
  ): Promise<FexiosFinalContext<T>> {
    // /v1/page/{title} + { title: 'Main Page' } = /v1/page/Main%20Page
    const { pathParams, ...restOptions } = options || {}
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
    const restEndpoint = this.getRestApiEndpoint()
    // Merge runtime configs (headers/fetch/credentials etc.) to match get/post behavior.
    // Note: deepMerge won't override with `undefined`, so we must handle responseType specially:
    // - default: auto-detect (remove responseType)
    // - if user explicitly provides responseType (even undefined), honor it
    const merged = deepMerge<Partial<FexiosRequestOptions>>(
      {},
      this.config.fexiosConfigs as Partial<FexiosRequestOptions>,
      restOptions
    ) as any
    if (!Object.prototype.hasOwnProperty.call(restOptions, 'responseType')) {
      delete merged.responseType
    } else {
      merged.responseType = (restOptions as any).responseType
    }
    return await this.request.request<T>({
      ...merged,
      // Prevent Fexios from inheriting baseURL search params into REST requests.
      // (Fexios merges baseURL.searchParams into request URL by default.)
      baseURL: this.normalizeEndpointNoSearchHash(this.config.baseURL),
      url: `${restEndpoint.replace(/\/$/, '')}/${path.replace(/^\//, '')}`,
      method,
    })
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
      // (For REST calls we also pass baseURL explicitly, so query/hash merging won't apply.)
      return endpoint
    }
  }

  private inferRestApiEndpointFromBaseURL(baseURL: string): string {
    // Convert https://example.org/w/api.php -> https://example.org/w/rest.php/
    // Also supports baseURL with query/hash or trailing slash.
    let u: URL
    try {
      // If baseURL is relative, resolve it against current location when available.
      const base = globalThis.location?.href || 'https://example.invalid/'
      u = new URL(baseURL, base)
    } catch {
      // Fallback for non-URL strings; keep behavior strict to avoid "weird" endpoints.
      if (/\/api\.php\/?$/i.test(baseURL)) {
        return baseURL.replace(/\/api\.php\/?$/i, '/rest.php/')
      }
      throw new WikiSaikouError(
        WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
        `Unable to infer REST endpoint from baseURL "${baseURL}". Set "restApiEndpoint" explicitly, or use a baseURL ending with "/api.php".`
      )
    }

    // Drop query/hash from baseURL when inferring rest.php base.
    u.search = ''
    u.hash = ''

    const p = u.pathname
    if (/\/api\.php\/?$/i.test(p)) {
      u.pathname = p.replace(/\/api\.php\/?$/i, '/rest.php/')
      return u.toString()
    }

    throw new WikiSaikouError(
      WikiSaikouErrorCode.INVALID_REST_ENDPOINT,
      `Unable to infer REST endpoint from baseURL "${baseURL}" (pathname "${p}"). Set "restApiEndpoint" explicitly, or use a baseURL ending with "/api.php".`
    )
  }

  private getRestApiEndpoint(): string {
    if (this.config.restApiEndpoint) {
      return this.normalizeEndpointNoSearchHash(this.config.restApiEndpoint)
    }
    return this.inferRestApiEndpointFromBaseURL(this.config.baseURL)
  }
}

export {
  MediaWikiRestApi as RestSaikou,
  /** @deprecated Use `MediaWikiRestApi` instead */
  MediaWikiRestApi as WikiSaikouRest,
}
