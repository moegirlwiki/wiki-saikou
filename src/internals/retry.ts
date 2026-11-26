import type { FexiosRequestOptions } from 'fexios'
import {
  createAbortError,
  linkAbortSignals,
  sleep,
  withTrackedAbortAndResponse,
} from './abort.js'
import type { RetryDelayOption, ShouldRetryOption } from './backoff.js'

const noop = () => {}

export interface RetryPolicy {
  retry?: number
  retryDelay?: RetryDelayOption
  onRetry?: (error: Error, retryCount: number) => void
  shouldRetry?: ShouldRetryOption
  signal?: AbortSignal
}

/** Validate that `retry` (maximum total attempts) is a finite integer >= 1. */
export const normalizeRetryCount = (retry: number): number => {
  if (!Number.isFinite(retry) || !Number.isInteger(retry) || retry < 1) {
    throw new RangeError('retry must be a finite integer >= 1')
  }
  return retry
}

/** Execute an async operation with configurable retries, backoff delay, and AbortSignal support. */
export const useRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryPolicy
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
      if (signal?.aborted) {
        throw createAbortError(signal)
      }
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

export interface RunRequestWithRetryParams<T> {
  options: Partial<FexiosRequestOptions>
  baseFetch: FexiosRequestOptions['fetch'] | undefined
  signal?: AbortSignal
  abortController?: AbortController
  retryPolicy: {
    retry: number
    retryDelay: RetryDelayOption
    onRetry?: (error: Error, retryCount: number) => void
    shouldRetry?: ShouldRetryOption
  }
  execute: (opts: Partial<FexiosRequestOptions>) => Promise<T>
  /** Optional wrapper around each attempt (e.g. MediaWiki API error mapping). */
  wrapAttempt?: (attempt: () => Promise<T>) => Promise<T>
}

/**
 * Shared request runner combining dual AbortSignal linking, tracked response
 * capture, retry count validation, and opt-in `useRetry`.
 * Used by both `WikiSaikouCore` (`get` / `post`) and `MediaWikiRestApi`.
 */
export async function runWithRetryAndAbort<T>(
  params: RunRequestWithRetryParams<T>
): Promise<T> {
  const {
    options,
    baseFetch,
    signal,
    abortController,
    retryPolicy,
    execute,
    wrapAttempt,
  } = params

  const maxAttempts = normalizeRetryCount(retryPolicy.retry)
  const { signal: effectiveSignal, cleanup } = linkAbortSignals(
    signal,
    abortController?.signal
  )

  const runAttempt = () => {
    const rawAttempt = () =>
      withTrackedAbortAndResponse(
        options,
        baseFetch,
        signal,
        abortController,
        execute
      )
    return wrapAttempt ? wrapAttempt(rawAttempt) : rawAttempt()
  }

  try {
    if (maxAttempts <= 1 || !retryPolicy.shouldRetry) {
      if (effectiveSignal?.aborted) {
        throw createAbortError(effectiveSignal)
      }
      return await runAttempt()
    }
    return await useRetry(runAttempt, {
      retry: maxAttempts,
      retryDelay: retryPolicy.retryDelay,
      onRetry: retryPolicy.onRetry,
      shouldRetry: retryPolicy.shouldRetry,
      signal: effectiveSignal,
    })
  } finally {
    cleanup()
  }
}
