import type { FexiosFinalContext } from 'fexios'
import type { MwApiResponse, MwApiResponseError } from '../types.js'

/** Error codes for WikiSaikouError */
export enum WikiSaikouErrorCode {
  HTTP_ERROR = 'HTTP_ERROR',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_RETRY_LIMIT_EXCEEDED = 'LOGIN_RETRY_LIMIT_EXCEEDED',
  TOKEN_RETRY_LIMIT_EXCEEDED = 'TOKEN_RETRY_LIMIT_EXCEEDED',
  INVALID_REST_PATH = 'INVALID_REST_PATH',
  INVALID_REST_ENDPOINT = 'INVALID_REST_ENDPOINT',
}

/**
 * SDK-level behavioral error (e.g., exhausted token retries, login failures,
 * or invalid REST endpoint/path configuration).
 * MediaWiki server-side API errors use `MediaWikiApiError`.
 */
export class WikiSaikouError extends Error {
  readonly name = 'WikiSaikouError'
  constructor(
    readonly code: WikiSaikouErrorCode,
    readonly message: string = '',
    readonly cause?: unknown
  ) {
    super(message)
  }
  static is(
    data?: unknown,
    code?: WikiSaikouErrorCode
  ): data is WikiSaikouError {
    return data instanceof this && (code === undefined || data.code === code)
  }
}

type RawMwApiError = MwApiResponseError & {
  info?: string
  '*'?: string
}

/**
 * Server-side MediaWiki API business error (response JSON contains `error` or `errors`).
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
    this.message = this.errors
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
  static is(data?: unknown): data is MediaWikiApiError {
    return data instanceof this
  }
  static normalizeErrors(errors: MwApiResponseError[]): MwApiResponseError[] {
    if (!Array.isArray(errors)) return []
    return errors
      .filter((e): e is RawMwApiError => typeof e === 'object' && Boolean(e?.code))
      .map((error) => {
        if (error.text) return error
        // `info` (rare) or `*` (formatversion=1) fallbacks
        const text = error.info || error['*'] || ''
        return { ...error, text }
      })
  }
}

interface ErrorDataContainer {
  data?: unknown
  response?: { data?: unknown }
  cause?: { data?: unknown; response?: { data?: unknown } }
}

/** Helper functions for WikiSaikouError and MediaWikiApiError */
export namespace WikiSaikouError {
  function extractResponseData<T = unknown>(data?: unknown): T | undefined {
    if (data == null || typeof data !== 'object') return undefined
    const obj = data as ErrorDataContainer
    if (obj.response?.data !== undefined) return obj.response.data as T
    if (obj.data !== undefined) return obj.data as T
    if (data instanceof Error && obj.cause) {
      if (obj.cause.response?.data !== undefined) {
        return obj.cause.response.data as T
      }
      if (obj.cause.data !== undefined) return obj.cause.data as T
    }
    return data as T
  }

  export function includesMediaWikiApiError(data?: unknown): boolean {
    return extractMediaWikiApiErrors(data).length > 0
  }

  export const normalizeMwApiErrors = MediaWikiApiError.normalizeErrors

  export function extractMediaWikiApiErrors(
    data?: unknown
  ): MwApiResponseError[] {
    const r = extractResponseData<MwApiResponse>(data)
    if (typeof r !== 'object' || r === null) return []

    const result: MwApiResponseError[] = []
    if (r.error) result.push(r.error)
    if (Array.isArray(r.errors)) result.push(...r.errors)
    return normalizeMwApiErrors(result)
  }

  export function isBadTokenError(data?: unknown): boolean {
    if (MediaWikiApiError.is(data)) {
      return data.isBadTokenError()
    }
    const responseData = extractResponseData<MwApiResponse>(data)
    if (['NeedToken', 'WrongToken'].includes(responseData?.login?.result)) {
      return true
    }
    const errors = extractMediaWikiApiErrors(data)
    return errors.some((error) => error.code === 'badtoken')
  }
}
