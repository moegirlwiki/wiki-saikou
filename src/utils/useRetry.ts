const noop = () => {}

export const useRetry = async <T>(
  fn: () => Promise<T>,
  options: {
    retry?: number
    onRetry?: (error: Error, retryCount: number) => void
    shouldRetry?: (error: Error, retryCount: number) => boolean
  }
): Promise<T> => {
  let retryCount = 0
  const { retry = 3, onRetry = noop, shouldRetry = () => true } = options
  let lastError: unknown
  do {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (shouldRetry(error as Error, retryCount)) {
        onRetry(error as Error, retryCount)
        retryCount++
      } else {
        throw error
      }
    }
  } while (retryCount < retry)
  throw (lastError as Error) || new Error('Retry failed')
}
