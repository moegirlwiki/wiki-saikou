import {
  Fexios,
  FexiosConfigs,
  FexiosRequestOptions,
  FexiosFinalContext,
} from 'fexios'
import {
  withTokenRetry,
  isBadTokenError,
  TokenRetryOptions,
} from './utils/with-retry.js'

export type * from 'fexios'

/**
 * WikiSaikou core
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class WikiSaikou {
  readonly version = import.meta.env.__VERSION__
  readonly request: Fexios
  private tokens: Record<string, string>

  readonly defaultParams: MwApiParams
  readonly defaultOptions: Partial<FexiosConfigs>

  static INIT_DEFAULT_PARAMS: MwApiParams = {
    action: 'query',
    errorformat: 'plaintext',
    format: 'json',
    formatversion: 2,
  }

  constructor(
    readonly baseURL: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL is undefined')
    }
    // Init
    this.baseURL = baseURL
    this.tokens = {}
    this.defaultParams = {
      ...WikiSaikou.INIT_DEFAULT_PARAMS,
      ...defaultParams,
    }
    this.defaultOptions = {
      responseType: 'json',
      ...defaultOptions,
    }

    this.request = WikiSaikou.createRequestHandler(
      this.baseURL,
      this.defaultOptions
    )
  }

  setBaseURL(baseURL: string) {
    this.request.baseConfigs.baseURL = baseURL
    return this
  }

  static normalizeParamValue(item: MwApiParams[keyof MwApiParams]) {
    if (Array.isArray(item)) {
      return item.join('|')
    } else if (typeof item === 'boolean') {
      return item ? '1' : undefined
    } else if (typeof item === 'number') {
      return '' + item
    } else {
      return item
    }
  }
  static createRequestHandler(
    baseURL: string,
    options?: Partial<FexiosConfigs>
  ) {
    const instance = new Fexios({
      baseURL,
      ...options,
    })

    // Adjust body
    instance.on('beforeInit', (ctx) => {
      if (ctx.method?.toLowerCase() !== 'post') {
        return ctx
      }

      if (
        typeof ctx.body === 'object' &&
        ctx.body !== null &&
        !(ctx.body instanceof URLSearchParams) &&
        !(ctx.body instanceof FormData)
      ) {
        const body: any = ctx.body
        Object.keys(body).forEach((key) => {
          const data = WikiSaikou.normalizeParamValue(body[key])
          if (typeof data === 'undefined' || data === null) {
            delete body[key]
          } else if (data !== body[key]) {
            body[key] = data
          }
        })
        ctx.body = new URLSearchParams(ctx.body as any)
      }

      if (
        (globalThis.FormData && ctx.body instanceof FormData) ||
        ctx.body instanceof URLSearchParams
      ) {
        const body = ctx.body
        // Adjust params
        body.forEach((value, key) => {
          const data = WikiSaikou.normalizeParamValue(value)
          if (typeof data === 'undefined' || data === null) {
            body.delete(key)
          } else if (data !== value) {
            body.set(key, data as any)
          }
        })
        // Adjust query
        const searchParams = new URLSearchParams(ctx.query as any)
        !searchParams.has('format') &&
          searchParams.set('format', '' + (body.get('format') || 'json'))
        !searchParams.has('formatversion') &&
          searchParams.set(
            'formatversion',
            '' + (body.get('formatversion') || '2')
          )
        body.has('origin') &&
          searchParams.set('origin', '' + body.get('origin'))
        ctx.query = Object.fromEntries(searchParams.entries())

        // DONT REMOVE THIS
        // TODO: Remove duplicate parameters. There should be a better solution.
        body.has('action') && (ctx.query.action = '' + body.get('action'))
      }

      return ctx
    })

    // Adjust query
    instance.on('beforeInit', (ctx) => {
      ctx.query = ctx.query as Record<string, any>
      for (const key in ctx.query) {
        const data = WikiSaikou.normalizeParamValue(ctx.query[key])
        if (typeof data === 'undefined' || data === null) {
          delete ctx.query[key]
        } else if (data !== ctx.query[key]) {
          ctx.query[key] = '' + data
        }
      }
      return ctx
    })

    // Adjust origin param
    instance.on('beforeRequest', (ctx) => {
      const url = new URL(ctx.url!)
      const searchParams = url.searchParams
      // Adjust origin param
      if (globalThis.location) {
        if (
          !searchParams.has('origin') &&
          location.origin !== new URL(baseURL).origin
        ) {
          searchParams.set('origin', location.origin)
          instance.baseConfigs.credentials = 'include'
          instance.baseConfigs.mode = 'cors'
        } else if (location.origin === new URL(baseURL).origin) {
          searchParams.delete('origin')
          instance.baseConfigs.credentials = undefined
          instance.baseConfigs.mode = undefined
        }
      }

      if (url.searchParams.has('origin')) {
        const origin = encodeURIComponent(
          url.searchParams.get('origin') || ''
        ).replace(/\./g, '%2E')
        ctx.query = {}
        url.searchParams.delete('origin')
        ctx.url = `${url}${url.search ? '&' : '?'}origin=${origin}`
      }
      return ctx
    })

    return instance
  }

  /** Base methods encapsulation */
  get<T = any>(query: MwApiParams, options?: FexiosRequestOptions) {
    return this.request.get<T>('', {
      ...this.defaultOptions,
      query: {
        ...this.defaultParams,
        ...this.defaultOptions.query,
        ...(query as any),
      },
      ...options,
    })
  }
  post<T = any>(
    data: MwApiParams | URLSearchParams | FormData,
    options?: FexiosRequestOptions
  ) {
    return this.request.post<T>('', data, {
      ...this.defaultOptions,
      query: { ...(this.defaultParams as any), ...this.defaultOptions.query },
      ...options,
    })
  }

  async getUserInfo(identity?: string | number): Promise<MwUserInfo | null> {
    if (!identity) {
      return this.getSelfUserInfo()
    }
    const { data } = await this.get<{
      query: {
        users: (Omit<MwUserInfo, 'id'> & { userid: number })[]
      }
    }>({
      action: 'query',
      list: 'users',
      usprop: ['groups', 'rights', 'blockinfo'],
      ususers: typeof identity === 'string' ? identity : undefined,
      ususerids: typeof identity === 'number' ? identity : undefined,
    })
    const user = data?.query?.users?.[0]
    if (!user) {
      return null
    }
    return {
      ...user,
      id: user.userid,
    }
  }

  async getSelfUserInfo() {
    const { data } = await this.get<{
      query: {
        userinfo: MwUserInfo
      }
    }>({
      action: 'query',
      meta: 'userinfo',
      uiprop: ['groups', 'rights', 'blockinfo'],
    })
    return data?.query?.userinfo || null
  }

  /** Token Handler */
  async getTokens(type: MwTokenName[] = ['csrf']) {
    this.defaultOptions.credentials = 'include'
    const { data } = await this.get({
      action: 'query',
      meta: 'tokens',
      type,
    })
    this.tokens = { ...this.tokens, ...data.query.tokens }
    return this.tokens
  }
  async token(type: MwTokenName = 'csrf', noCache = false) {
    if (!this.tokens[`${type}token`] || noCache) {
      delete this.tokens[`${type}token`]
      await this.getTokens([type])
    }
    return this.tokens[`${type}token`]
  }

  async postWithToken<T = any>(
    tokenType: MwTokenName,
    body: MwApiParams,
    options?: {
      tokenName?: string
      retry?: number
      noCache?: boolean
    } & TokenRetryOptions
  ): Promise<FexiosFinalContext<T>> {
    const {
      tokenName = 'token',
      retry = 3,
      noCache = false,
      ...retryOptions
    } = options || {}

    // For compatibility
    retryOptions.maxRetries ??= retry

    return withTokenRetry(
      async () => {
        const token = await this.token(tokenType, noCache)
        return this.post<T>({
          [tokenName]: token,
          ...body,
        })
      },
      {
        ...retryOptions,
        shouldRetry: (err) => {
          const data = err.data
          return WikiSaikou.isBadTokenError(data) || err?.ok === false
        },
        onTokenError: async (err, retryCount) => {
          // 清理指定类型的token缓存
          delete this.tokens[`${tokenType}token`]
          if (typeof retryOptions.onTokenError === 'function') {
            await retryOptions.onTokenError(err, retryCount)
          }
        },
      }
    ).catch((err) => {
      const data = err.data
      if (typeof data === 'object' && data !== null) {
        return Promise.reject(data)
      } else {
        throw new WikiSaikouError(
          WikiSaikouErrorCode.HTTP_ERROR,
          "The server returns an error, but it doesn't seem to be caused by MediaWiki",
          err
        )
      }
    })
  }
  postWithEditToken<T = any>(body: MwApiParams) {
    return this.postWithToken<T>('csrf', body)
  }

  // For compatibility
  static isBadTokenError = isBadTokenError

  async getMessages(ammessages: string[], amlang = 'zh', options: MwApiParams) {
    const { data } = await this.get({
      action: 'query',
      meta: 'allmessages',
      ammessages,
      amlang,
      ...options,
    })
    const result: Record<string, string> = {}
    data.query.allmessages.forEach(function (obj: {
      missing?: boolean
      name: string
      content: string
    }) {
      if (!obj.missing) {
        result[obj.name] = obj.content
      }
    })
    return result
  }

  async parseWikitext(
    wikitext: string,
    title?: string,
    extraBody?: MwApiParams,
    options?: FexiosRequestOptions
  ): Promise<string> {
    const { data } = await this.post(
      {
        action: 'parse',
        title,
        text: wikitext,
        ...extraBody,
      },
      options
    )
    return data.parse.text
  }
}

// Errors
export enum WikiSaikouErrorCode {
  HTTP_ERROR = 'HTTP_ERROR',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_RETRY_LIMIT_EXCEEDED = 'LOGIN_RETRY_LIMIT_EXCEEDED',
  TOKEN_RETRY_LIMIT_EXCEEDED = 'TOKEN_RETRY_LIMIT_EXCEEDED',
  RETRY_LIMIT_EXCEEDED = 'RETRY_LIMIT_EXCEEDED',
}
export class WikiSaikouError extends Error {
  readonly name = 'WikiSaikouError'
  constructor(
    readonly code: WikiSaikouErrorCode,
    readonly message: string = '',
    readonly cause?: FexiosFinalContext
  ) {
    super()
  }
}

// Types
export type MwApiParams = Record<
  string,
  string | number | string[] | undefined | boolean | File
>
export type MwTokenName =
  | 'createaccount'
  | 'csrf'
  | 'login'
  | 'patrol'
  | 'rollback'
  | 'userrights'
  | 'watch'

export interface MwUserInfo {
  id: number
  name: string
  groups: string[]
  rights: string[]
  blockid?: number
  blockedby?: string
  blockedbyid?: number
  blockreason?: string
  blockexpiry?: string
  blockedtimestamp?: string
}
