import type { FexiosRequestOptions } from 'fexios'

const noop = () => {}

/** Create a standard AbortError (or return signal.reason directly if it is already an Error). */
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

/**
 * Combine up to two AbortSignals into a single effective signal.
 * Callers must invoke `cleanup()` in a `finally` block to detach listeners.
 */
export const linkAbortSignals = (
  signal?: AbortSignal,
  controllerSignal?: AbortSignal
): { signal?: AbortSignal; cleanup: () => void } => {
  if (!signal) return { signal: controllerSignal, cleanup: noop }
  if (!controllerSignal || signal === controllerSignal) {
    return { signal, cleanup: noop }
  }
  if (signal.aborted) return { signal, cleanup: noop }
  if (controllerSignal.aborted) {
    return { signal: controllerSignal, cleanup: noop }
  }

  const combined = new AbortController()
  const onSignalAbort = () => combined.abort(signal.reason)
  const onControllerAbort = () => combined.abort(controllerSignal.reason)
  signal.addEventListener('abort', onSignalAbort, { once: true })
  controllerSignal.addEventListener('abort', onControllerAbort, { once: true })

  return {
    signal: combined.signal,
    cleanup: () => {
      signal.removeEventListener('abort', onSignalAbort)
      controllerSignal.removeEventListener('abort', onControllerAbort)
    },
  }
}

/**
 * Attach `rawResponse` as a non-enumerable property on an error object when missing,
 * allowing retry/backoff helpers to inspect response headers (e.g. Retry-After)
 * without mutating the original error type or masking it.
 */
export const attachRawResponseSafely = (
  err: unknown,
  rawResponse: Response | undefined
): void => {
  if (
    !rawResponse ||
    !err ||
    typeof err !== 'object' ||
    'rawResponse' in err ||
    !Object.isExtensible(err)
  ) {
    return
  }
  try {
    Object.defineProperty(err, 'rawResponse', {
      value: rawResponse,
      configurable: true,
      writable: true,
      enumerable: false,
    })
  } catch {
    // Never mask the original error if defining rawResponse fails
  }
}

/**
 * Execute a Fexios request while forwarding caller `AbortSignal` to Fexios's
 * `abortController` and tracking the underlying `Response` for error inspection.
 */
export const withTrackedAbortAndResponse = <T>(
  options: Partial<FexiosRequestOptions>,
  instanceBaseFetch: FexiosRequestOptions['fetch'] | undefined,
  signal: AbortSignal | undefined,
  existingController: AbortController | undefined,
  fn: (opts: Partial<FexiosRequestOptions>) => Promise<T>
): Promise<T> => {
  if (signal?.aborted) {
    existingController?.abort(signal.reason)
    return Promise.reject(createAbortError(signal))
  }
  if (existingController?.signal.aborted) {
    return Promise.reject(createAbortError(existingController.signal))
  }

  let lastResponse: Response | undefined
  const resolvedFetch = options.fetch ?? instanceBaseFetch
  const trackedOptions: Partial<FexiosRequestOptions> =
    resolvedFetch || typeof globalThis.fetch === 'function'
      ? {
          ...options,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const res = resolvedFetch
              ? await resolvedFetch(input, init)
              : await globalThis.fetch(input, init)
            lastResponse = res
            return res
          },
        }
      : { ...options }

  const attachOnError = (err: unknown): never => {
    attachRawResponseSafely(err, lastResponse)
    throw err
  }

  if (!signal) {
    if (existingController) trackedOptions.abortController = existingController
    return fn(trackedOptions).catch(attachOnError)
  }

  const targetController = existingController ?? new AbortController()
  const onAbort = () => targetController.abort(signal.reason)
  const cleanup = () => signal.removeEventListener('abort', onAbort)
  signal.addEventListener('abort', onAbort, { once: true })
  trackedOptions.abortController = targetController

  try {
    return fn(trackedOptions).catch(attachOnError).finally(cleanup)
  } catch (err) {
    cleanup()
    attachRawResponseSafely(err, lastResponse)
    return Promise.reject(err)
  }
}

/** Race an existing promise against an AbortSignal without cancelling the underlying promise. */
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

/** Abort-aware timer sleep used for retry backoff delays. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
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
