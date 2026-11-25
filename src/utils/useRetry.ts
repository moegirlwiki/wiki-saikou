import { FexiosError, FexiosErrorCodes, FexiosResponseError } from 'fexios'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from '../models/errors.js'

const noop = () => {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  /fetch|network|load failed|connection|socket|timed?\s*out/i

const isRetryableStatus = (status: unknown): boolean =>
  status === 429 || (typeof status === 'number' && status >= 500)

const extractResponseStatus = (error: unknown): number | undefined => {
  const candidates = [
    (error as any)?.response?.status,
    (error as any)?.context?.response?.status,
    (error as any)?.context?.rawResponse?.status,
  ]
  return candidates.find((s): s is number => typeof s === 'number')
}

export const isRetryableTransportError = (
  error: unknown,
  visited = new Set<unknown>()
): boolean => {
  if (!error || MediaWikiApiError.is(error) || visited.has(error)) {
    return false
  }
  visited.add(error)
  if (WikiSaikouError.is(error)) {
    if (error.code !== WikiSaikouErrorCode.HTTP_ERROR) {
      return false
    }
    return error.cause ? isRetryableTransportError(error.cause, visited) : true
  }
  const status = extractResponseStatus(error)
  if (status !== undefined) {
    return isRetryableStatus(status)
  }
  if (FexiosResponseError.is(error)) {
    return isRetryableStatus(error.response?.status)
  }
  if (FexiosError.is(error)) {
    if (error.code === FexiosErrorCodes.NETWORK_ERROR) {
      if (NETWORK_TYPE_ERROR_RE.test(error.message)) {
        return true
      }
      return error.cause ? isRetryableTransportError(error.cause, visited) : false
    }
    return (
      error.code === FexiosErrorCodes.TIMEOUT ||
      error.code === FexiosErrorCodes.BODY_TRANSFORM_ERROR
    )
  }
  if (error instanceof TypeError && NETWORK_TYPE_ERROR_RE.test(error.message)) {
    return true
  }
  const errCode = (error as { code?: unknown; cause?: { code?: unknown } })
    ?.code
  if (typeof errCode === 'string' && TRANSIENT_ERROR_CODES.has(errCode)) {
    return true
  }
  const cause = (error as { cause?: unknown })?.cause
  return cause !== undefined
    ? isRetryableTransportError(cause, visited)
    : false
}

const RETRYABLE_MW_ERROR_CODES = new Set(['maxlag', 'ratelimited'])

export type RetryDelayOption =
  | number
  | ((error: Error, retryCount: number) => number)

export const isRetryableMediaWikiError = (
  error: unknown,
  visited = new Set<unknown>()
): boolean => {
  if (!error || visited.has(error)) return false
  visited.add(error)
  if (MediaWikiApiError.is(error)) {
    return error.errors.some((e) => RETRYABLE_MW_ERROR_CODES.has(e.code))
  }
  if (WikiSaikouError.is(error) && error.cause) {
    return isRetryableMediaWikiError(error.cause, visited)
  }
  return false
}

export const isRetryableRequestError = (error: unknown): boolean =>
  isRetryableTransportError(error) || isRetryableMediaWikiError(error)

export const parseRetryAfterMs = (error: unknown): number | undefined => {
  const candidates = [
    (error as any)?.response?.headers,
    (error as any)?.headers,
    (error as any)?.cause?.response?.headers,
    (error as any)?.cause?.headers,
  ]
  for (const headers of candidates) {
    const raw =
      typeof headers?.get === 'function'
        ? headers.get('retry-after')
        : headers?.['retry-after'] ?? headers?.['Retry-After']
    if (raw == null || raw === '') continue
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60000, Math.round(seconds * 1000))
    }
    const dateMs = Date.parse(String(raw))
    if (Number.isFinite(dateMs)) {
      return Math.min(60000, Math.max(0, dateMs - Date.now()))
    }
  }
  return undefined
}

export const defaultTransportRetryDelay = (
  error: Error,
  retryCount: number
): number => {
  if (!isRetryableRequestError(error)) {
    return 0
  }
  const retryAfter = parseRetryAfterMs(error)
  if (retryAfter !== undefined) {
    return retryAfter
  }
  return Math.min(5000, 100 * 2 ** retryCount)
}

export const useRetry = async <T>(
  fn: () => Promise<T>,
  options: {
    retry?: number
    retryDelay?: number | ((error: Error, retryCount: number) => number)
    onRetry?: (error: Error, retryCount: number) => void
    shouldRetry?: (error: Error, retryCount: number) => boolean
  }
): Promise<T> => {
  let retryCount = 0
  const {
    retry = 3,
    retryDelay = 0,
    onRetry = noop,
    shouldRetry = () => true,
  } = options
  if (!Number.isFinite(retry)) {
    throw new RangeError('retry must be a finite number')
  }
  let lastError: unknown
  do {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const err = error as Error
      if (shouldRetry(err, retryCount)) {
        onRetry(err, retryCount)
        if (retryCount + 1 < retry) {
          const delay =
            typeof retryDelay === 'function'
              ? retryDelay(err, retryCount)
              : retryDelay
          if (Number.isFinite(delay) && delay > 0) {
            await sleep(delay)
          }
        }
        retryCount++
      } else {
        throw error
      }
    }
  } while (retryCount < retry)
  throw (lastError as Error) || new Error('Retry failed')
}
