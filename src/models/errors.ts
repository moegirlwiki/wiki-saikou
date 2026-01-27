import type { FexiosFinalContext } from 'fexios'
import { MwApiResponse, MwApiResponseError } from '../types.js'

/**
 * Error codes for WikiSaikouError
 */
export enum WikiSaikouErrorCode {
  HTTP_ERROR = 'HTTP_ERROR',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_RETRY_LIMIT_EXCEEDED = 'LOGIN_RETRY_LIMIT_EXCEEDED',
  TOKEN_RETRY_LIMIT_EXCEEDED = 'TOKEN_RETRY_LIMIT_EXCEEDED',
  INVALID_REST_PATH = 'INVALID_REST_PATH',
  INVALID_REST_ENDPOINT = 'INVALID_REST_ENDPOINT',
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
    this.errors = MediaWikiApiError.normalizeErrors(errors)
    this.message = errors
      .map((error) => error.text)
      .filter(Boolean)
      .join('\n')
    this.code = this.isBadTokenError()
      ? 'badtoken'
      : this.errors[0]?.code || 'Unknown Error'
  }
  get firstError() {
    return this.errors[0]
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
  static normalizeErrors(errors: MwApiResponseError[]): MwApiResponseError[] {
    if (Array.isArray(errors) === false) {
      return []
    }
    return errors
      .filter((e) => typeof e === 'object' && !!e?.code)
      .map((error: any) => {
        if (!error.text) {
          if (error.info) {
            // in rare cases, `info` appears instead of `text`
            return { ...error, text: error.info }
          } else if (error['*']) {
            // for formatversion=1, `*` is preferred over `text`
            return { ...error, text: error['*'] }
          } else {
            return { ...error, text: '' }
          }
        }
        return error
      })
  }
}

/**
 * Helper functions for WikiSaikouError and MediaWikiApiError
 */
export namespace WikiSaikouError {
  function extractResponseDataFromAny<T = any>(data?: any): T | undefined {
    if (data == null) return undefined
    // Prefer FexiosResponseError.response.data if present
    if (data?.response?.data !== undefined) return data.response.data as T
    // Then prefer context-like objects that already have data
    if (data?.data !== undefined) return data.data as T
    // Fall back to Error.cause chain
    const cause = data instanceof Error ? (data as any).cause : undefined
    if (cause?.response?.data !== undefined) return cause.response.data as T
    if (cause?.data !== undefined) return cause.data as T
    return (data as T) || undefined
  }

  export function includesMediaWikiApiError(data?: any) {
    return extractMediaWikiApiErrors(data).length > 0
  }

  export const normalizeMwApiErrors = MediaWikiApiError.normalizeErrors

  export function extractMediaWikiApiErrors(data?: any): MwApiResponseError[] {
    let r = extractResponseDataFromAny<MwApiResponse>(data)
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
    return normalizeMwApiErrors(result)
  }

  export function isBadTokenError(data?: any): boolean {
    if (MediaWikiApiError.is(data)) {
      return data.isBadTokenError()
    } else {
      const errors = extractMediaWikiApiErrors(data)
      return new MediaWikiApiError(errors).isBadTokenError()
    }
  }
}
