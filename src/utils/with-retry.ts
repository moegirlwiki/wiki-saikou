export interface RetryOptions {
  /** 最大重试次数，默认0 */
  maxRetries?: number
  /** 重试间隔（毫秒），默认0 */
  interval?: number
  /** 重试条件，默认总是重试 */
  shouldRetry?: (err: any) => boolean
  /** 错误处理钩子，在重试前调用 */
  onError?: (err: any, retryCount: number) => void | Promise<void>
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions | number = {}
): Promise<T> {
  // 兼容旧的API
  if (typeof options === 'number') {
    options = { maxRetries: options }
  }

  const {
    maxRetries = 0,
    interval = 0,
    shouldRetry = () => true,
    onError,
  } = options

  return fn().catch(async (err) => {
    if (!shouldRetry(err)) {
      throw err
    }
    if (maxRetries > 0) {
      // 调用错误处理钩子
      if (onError) {
        await onError(err, maxRetries)
      }

      // 等待重试间隔
      if (interval > 0) {
        await new Promise((resolve) => setTimeout(resolve, interval))
      }

      return withRetry(fn, {
        maxRetries: maxRetries - 1,
        interval,
        shouldRetry,
        onError,
      })
    }
    return Promise.reject(err)
  })
}

/**
 * TokenError重试配置
 */
export interface TokenRetryOptions extends RetryOptions {
  /** Token清理钩子，在重试前调用 */
  onTokenError?: (err: any, retryCount: number) => void | Promise<void>
}

/**
 * 检查是否为TokenError
 */
export function isBadTokenError(data?: any): boolean {
  return (
    data?.error?.code === 'badtoken' ||
    data?.errors?.some((i: any) => i.code === 'badtoken') ||
    ['NeedToken', 'WrongToken'].includes(data?.login?.result)
  )
}

/**
 * 带TokenError处理的通用重试函数
 */
export function withTokenRetry<T>(
  fn: () => Promise<T>,
  options: TokenRetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    interval = 0,
    shouldRetry = (err) => isBadTokenError(err.data) || err?.ok === false,
    onTokenError,
    onError,
  } = options

  // 合并错误处理钩子
  const combinedOnError = async (err: any, retryCount: number) => {
    // 先调用通用的错误处理钩子
    if (onError) {
      await onError(err, retryCount)
    }

    // 如果是TokenError，调用专门的Token清理钩子
    if (isBadTokenError(err.data) && onTokenError) {
      await onTokenError(err, retryCount)
    }
  }

  return withRetry(fn, {
    maxRetries,
    interval,
    shouldRetry,
    onError: combinedOnError,
  })
}
