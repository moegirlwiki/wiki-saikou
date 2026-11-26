import { FexiosError, FexiosErrorCodes, FexiosResponseError } from 'fexios'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from '../models/errors.js'

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

const NETWORK_TYPE_ERROR_RE =
  /^(?:fetch failed|failed to fetch|load failed|network(?:error| error| request failed))|econnreset|etimedout|econnrefused|eai_again|socket|timed?\s*out/i

interface ErrorLike {
  code?: unknown
  cause?: unknown
  headers?: Headers | Record<string, unknown>
  response?: { status?: unknown; headers?: Headers | Record<string, unknown> }
  rawResponse?: { status?: unknown; headers?: Headers | Record<string, unknown> }
  context?: {
    response?: { status?: unknown; headers?: Headers | Record<string, unknown> }
    rawResponse?: {
      status?: unknown
      headers?: Headers | Record<string, unknown>
    }
  }
}

const isRetryableStatus = (status: unknown): boolean =>
  status === 429 || (typeof status === 'number' && status >= 500)

const extractResponseStatus = (error: unknown): number | undefined => {
  const err = error as ErrorLike | undefined
  const candidates = [
    err?.response?.status,
    err?.rawResponse?.status,
    err?.context?.response?.status,
    err?.context?.rawResponse?.status,
  ]
  return candidates.find((s): s is number => typeof s === 'number')
}

const checkRetryableTransportError = (
  error: unknown,
  visited = new Set<unknown>()
): boolean => {
  if (!error || visited.has(error)) return false
  visited.add(error)

  if (MediaWikiApiError.is(error)) {
    const mwStatus =
      extractResponseStatus(error) ?? extractResponseStatus(error.cause)
    return mwStatus !== undefined && isRetryableStatus(mwStatus)
  }

  if (WikiSaikouError.is(error)) {
    if (error.code !== WikiSaikouErrorCode.HTTP_ERROR) return false
    return error.cause
      ? checkRetryableTransportError(error.cause, visited)
      : true
  }

  const status = extractResponseStatus(error)
  if (status !== undefined) return isRetryableStatus(status)

  if (FexiosResponseError.is(error)) {
    return isRetryableStatus(error.response?.status)
  }

  if (FexiosError.is(error)) {
    if (error.code === FexiosErrorCodes.NETWORK_ERROR) {
      if (NETWORK_TYPE_ERROR_RE.test(error.message)) return true
      return error.cause
        ? checkRetryableTransportError(error.cause, visited)
        : false
    }
    return error.code === FexiosErrorCodes.TIMEOUT
  }

  if (
    error instanceof TypeError &&
    NETWORK_TYPE_ERROR_RE.test(error.message)
  ) {
    return true
  }

  const errObj = error as ErrorLike
  if (typeof errObj.code === 'string' && TRANSIENT_ERROR_CODES.has(errObj.code)) {
    return true
  }

  return errObj.cause !== undefined
    ? checkRetryableTransportError(errObj.cause, visited)
    : false
}

/** Predicate identifying transient network, timeout, HTTP 429, or HTTP 5xx errors. */
export const isRetryableTransportError = (error: unknown): boolean =>
  checkRetryableTransportError(error)

export type RetryDelayOption =
  | number
  | ((error: Error, retryCount: number) => number)

export type ShouldRetryOption = (error: Error, retryCount: number) => boolean

export interface RetryDelayOptions {
  /** Initial backoff delay in milliseconds. @default 100 */
  baseDelayMs?: number
  /** Maximum exponential backoff delay in milliseconds. @default 5000 */
  maxDelayMs?: number
  /** Maximum delay honored from `Retry-After` header in milliseconds. @default 60000 */
  maxRetryAfterMs?: number
  /**
   * Additive random jitter ratio (e.g. `0.2` adds up to +20%, `true` equals `0.2`).
   * @default 0
   */
  jitter?: number | boolean
}

function readRetryAfterHeader(
  headers: Headers | Record<string, unknown> | undefined
): string | undefined {
  if (!headers) return undefined
  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : (headers as Record<string, unknown>)['retry-after'] ??
        (headers as Record<string, unknown>)['Retry-After']
  if (raw == null) return undefined
  const trimmed = String(raw).trim()
  return trimmed || undefined
}

/**
 * Extract a delay in milliseconds from an HTTP `Retry-After` header attached
 * anywhere along an error's response/context/cause chain.
 */
export const parseRetryAfterMs = (
  error: unknown,
  maxRetryAfterMs = 60000
): number | undefined => {
  const cap =
    Number.isFinite(maxRetryAfterMs) && maxRetryAfterMs >= 0
      ? maxRetryAfterMs
      : 60000

  const visited = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const err = current as ErrorLike
    const candidates = [
      err.response?.headers,
      err.rawResponse?.headers,
      err.context?.response?.headers,
      err.context?.rawResponse?.headers,
      err.headers,
    ]
    for (const headers of candidates) {
      const value = readRetryAfterHeader(headers)
      if (!value) continue

      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(cap, Math.round(seconds * 1000))
      }
      const dateMs = Date.parse(value)
      if (Number.isFinite(dateMs)) {
        return Math.min(cap, Math.max(0, dateMs - Date.now()))
      }
    }
    current = err.cause
  }

  return undefined
}

/** Build an exponential backoff delay function that honors `Retry-After` headers. */
export const createRetryDelay = (
  options: RetryDelayOptions = {}
): ((error: Error, retryCount: number) => number) => {
  const {
    baseDelayMs = 100,
    maxDelayMs = 5000,
    maxRetryAfterMs = 60000,
    jitter = 0,
  } = options
  const jitterRatio =
    jitter === true
      ? 0.2
      : typeof jitter === 'number' && Number.isFinite(jitter) && jitter > 0
        ? jitter
        : 0

  return (error: Error, retryCount: number): number => {
    const retryAfter = parseRetryAfterMs(error, maxRetryAfterMs)
    if (retryAfter !== undefined) return retryAfter
    if (WikiSaikouError.isBadTokenError(error)) return 0

    const base = Math.min(maxDelayMs, baseDelayMs * 2 ** retryCount)
    return jitterRatio > 0
      ? Math.round(base + Math.random() * jitterRatio * base)
      : base
  }
}

export const defaultTransportRetryDelay = createRetryDelay()
