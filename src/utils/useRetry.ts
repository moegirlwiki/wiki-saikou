import { FexiosError, FexiosErrorCodes, FexiosResponseError } from 'fexios'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from '../models/errors.js'

const noop = () => {}

export const createAbortError = (signal?: AbortSignal): Error => {
  if (signal?.reason instanceof Error) {
    return signal.reason
  }
  const err = new Error(
    signal?.reason ? String(signal.reason) : 'The operation was aborted'
  )
  err.name = 'AbortError'
  return err
}

export const raceWithSignal = <T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createAbortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAbortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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

const isRetryableStatus = (status: unknown): boolean =>
  status === 429 || (typeof status === 'number' && status >= 500)

const extractResponseStatus = (error: unknown): number | undefined => {
  const candidates = [
    (error as any)?.response?.status,
    (error as any)?.rawResponse?.status,
    (error as any)?.context?.response?.status,
    (error as any)?.context?.rawResponse?.status,
  ]
  return candidates.find((s): s is number => typeof s === 'number')
}

const checkRetryableTransportError = (
  error: unknown,
  visited = new Set<unknown>()
): boolean => {
  if (!error || visited.has(error)) {
    return false
  }
  visited.add(error)
  if (MediaWikiApiError.is(error)) {
    const mwStatus =
      extractResponseStatus(error) ?? extractResponseStatus(error.cause)
    return mwStatus !== undefined ? isRetryableStatus(mwStatus) : false
  }
  if (WikiSaikouError.is(error)) {
    if (error.code !== WikiSaikouErrorCode.HTTP_ERROR) {
      return false
    }
    return error.cause ? checkRetryableTransportError(error.cause, visited) : true
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
      return error.cause
        ? checkRetryableTransportError(error.cause, visited)
        : false
    }
    return error.code === FexiosErrorCodes.TIMEOUT
  }
  if (error instanceof TypeError && NETWORK_TYPE_ERROR_RE.test(error.message)) {
    return true
  }
  const errCode = (error as { code?: unknown })?.code
  if (typeof errCode === 'string' && TRANSIENT_ERROR_CODES.has(errCode)) {
    return true
  }
  const cause = (error as { cause?: unknown })?.cause
  return cause !== undefined ? checkRetryableTransportError(cause, visited) : false
}

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

export const parseRetryAfterMs = (
  error: unknown,
  maxRetryAfterMs = 60000
): number | undefined => {
  const visited = new Set<unknown>()
  let current: any = error
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const candidates = [
      current.response?.headers,
      current.rawResponse?.headers,
      current.headers,
    ]
    for (const headers of candidates) {
      const raw =
        typeof headers?.get === 'function'
          ? headers.get('retry-after')
          : headers?.['retry-after'] ?? headers?.['Retry-After']
      if (raw == null || raw === '') continue
      const seconds = Number(raw)
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(maxRetryAfterMs, Math.round(seconds * 1000))
      }
      const dateMs = Date.parse(String(raw))
      if (Number.isFinite(dateMs)) {
        return Math.min(maxRetryAfterMs, Math.max(0, dateMs - Date.now()))
      }
    }
    current = current.cause
  }
  return undefined
}

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
    jitter === true ? 0.2 : typeof jitter === 'number' && jitter > 0 ? jitter : 0

  return (error: Error, retryCount: number): number => {
    const retryAfter = parseRetryAfterMs(error, maxRetryAfterMs)
    if (retryAfter !== undefined) {
      return retryAfter
    }
    if (WikiSaikouError.isBadTokenError(error)) {
      return 0
    }
    const base = Math.min(maxDelayMs, baseDelayMs * 2 ** retryCount)
    if (jitterRatio > 0) {
      return Math.round(base + Math.random() * jitterRatio * base)
    }
    return base
  }
}

export const defaultTransportRetryDelay = createRetryDelay()

export const normalizeRetryCount = (retry: number): number => {
  if (!Number.isFinite(retry) || !Number.isInteger(retry) || retry < 1) {
    throw new RangeError('retry must be a finite integer >= 1')
  }
  return retry
}

export const useRetry = async <T>(
  fn: () => Promise<T>,
  options: {
    retry?: number
    retryDelay?: RetryDelayOption
    onRetry?: (error: Error, retryCount: number) => void
    shouldRetry?: ShouldRetryOption
    signal?: AbortSignal
  }
): Promise<T> => {
  const {
    retry = 3,
    retryDelay = 0,
    onRetry = noop,
    shouldRetry = () => true,
    signal,
  } = options
  const maxAttempts = normalizeRetryCount(retry)
  let retryCount = 0
  let lastError: unknown
  do {
    if (signal?.aborted) {
      throw createAbortError(signal)
    }
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const err = error as Error
      if (retryCount + 1 < maxAttempts && shouldRetry(err, retryCount)) {
        const delay =
          typeof retryDelay === 'function'
            ? retryDelay(err, retryCount)
            : retryDelay
        const safeDelay = Number.isFinite(delay) && delay > 0 ? delay : 0
        onRetry(err, retryCount)
        if (safeDelay > 0) {
          await sleep(safeDelay, signal)
        }
        retryCount++
      } else {
        throw error
      }
    }
  } while (retryCount < maxAttempts)
  throw (lastError as Error) || new Error('Retry failed')
}
