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

export const isRetryableTransportError = (error: unknown): boolean => {
  if (!error || MediaWikiApiError.is(error)) {
    return false
  }
  if (WikiSaikouError.is(error)) {
    if (error.code !== WikiSaikouErrorCode.HTTP_ERROR) {
      return false
    }
    return error.cause ? isRetryableTransportError(error.cause) : true
  }
  if (FexiosResponseError.is(error)) {
    const status = error.response?.status
    return status === 429 || (typeof status === 'number' && status >= 500)
  }
  if (FexiosError.is(error)) {
    if (
      error.code === FexiosErrorCodes.NETWORK_ERROR ||
      error.code === FexiosErrorCodes.TIMEOUT ||
      error.code === FexiosErrorCodes.BODY_TRANSFORM_ERROR
    ) {
      return true
    }
    const ctxStatus = (error.context as { response?: { status?: number } })
      ?.response?.status
    if (ctxStatus === 429 || (typeof ctxStatus === 'number' && ctxStatus >= 500)) {
      return true
    }
  }
  const responseStatus = (error as { response?: { status?: number } })
    ?.response?.status
  if (
    responseStatus === 429 ||
    (typeof responseStatus === 'number' && responseStatus >= 500)
  ) {
    return true
  }
  if (error instanceof TypeError) {
    return true
  }
  const errCode = (error as { code?: unknown; cause?: { code?: unknown } })
    ?.code
  if (typeof errCode === 'string' && TRANSIENT_ERROR_CODES.has(errCode)) {
    return true
  }
  const cause = (error as { cause?: unknown })?.cause
  return cause !== undefined && cause !== error
    ? isRetryableTransportError(cause)
    : false
}

export const defaultTransportRetryDelay = (
  error: Error,
  retryCount: number
): number => {
  if (!isRetryableTransportError(error)) {
    return 0
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
          if (delay > 0) {
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
