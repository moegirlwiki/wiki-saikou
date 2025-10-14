import {
  Fexios,
  FexiosConfigs,
  FexiosRequestOptions,
  FexiosFinalContext,
  checkIsPlainObject,
} from 'fexios'

/**
 * MediaWiki Api
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MwApiBase {
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
    readonly baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    // For MediaWiki browser environment
    if (!baseURL && typeof window === 'object' && (window as any).mediaWiki) {
      const { wgServer, wgScriptPath } =
        (window as any).mediaWiki?.config?.get(['wgServer', 'wgScriptPath']) ||
        {}
      if (typeof wgServer === 'string' && typeof wgScriptPath === 'string') {
        baseURL = `${wgServer}${wgScriptPath}/api.php`
      }
    }
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL is undefined')
    }
    // Init
    this.baseURL = baseURL
    this.tokens = {}
    this.defaultParams = {
      ...MwApiBase.INIT_DEFAULT_PARAMS,
      ...defaultParams,
    }
    this.defaultOptions = {
      responseType: 'json',
      ...defaultOptions,
    }

    this.request = MwApiBase.createRequestHandler(this.baseURL)
  }

  setBaseURL(baseURL: string) {
    this.request.baseConfigs.baseURL = baseURL
    return this
  }

  static normalizeParamValue(item: any): string | Blob | undefined {
    if (Array.isArray(item)) {
      return item.join('|')
    } else if (typeof item === 'boolean' || item === null) {
      return item ? '1' : undefined
    } else if (typeof item === 'number') {
      return '' + item
    } else {
      return item
    }
  }

  static normalizeBody(body: any): URLSearchParams | FormData | undefined {
    const isFormLike = (body: any): body is URLSearchParams | FormData =>
      body && (body instanceof URLSearchParams || body instanceof FormData)

    if (body === void 0 || body === null) {
      return void 0
    }

    if (isFormLike(body)) {
      body.forEach((value, key) => {
        const data = MwApiBase.normalizeParamValue(value)
        if (data === void 0 || data === null) {
          body.delete(key)
        } else if (data !== value) {
          body.set(key, data as any)
        }
      })
      return body
    }

    if (checkIsPlainObject(body)) {
      body = Object.fromEntries(
        Object.entries(body)
          .map(([key, value]) => [key, MwApiBase.normalizeParamValue(value)])
          .filter(([key, value]) => value !== void 0 && value !== null)
      )

      const hasBlob = Object.values(body).some(
        (value) => value instanceof File || value instanceof Blob
      )

      if (hasBlob) {
        body = new FormData()
        Object.entries(body).forEach(([key, value]) => {
          body.append(key, value)
        })
      } else {
        body = new URLSearchParams(body as any)
      }

      return body
    }

    return void 0
  }

  static createRequestHandler(baseURL: string) {
    const instance = new Fexios({
      baseURL,
      responseType: 'json',
    })

    // Adjust body
    instance.on('beforeInit', (ctx) => {
      if (ctx.method?.toLowerCase() !== 'post') {
        return ctx
      }

      if (ctx.body === void 0 || ctx.body === null) {
        ctx.body = void 0
        return ctx
      }

      const body = (ctx.body = MwApiBase.normalizeBody(ctx.body)!)

      // remove duplicate params
      const query = new URLSearchParams(ctx.query as any)
      if (body.has('format')) {
        query.delete('format')
      }
      if (body.has('formatversion')) {
        query.delete('formatversion')
      }
      if (body.has('action')) {
        query.delete('action')
      }
      // `origin` must be in query because of CORS
      if (body.has('origin')) {
        query.set('origin', '' + body.get('origin'))
        body.delete('origin')
      }
      ctx.query = Object.fromEntries(query.entries())

      return ctx
    })

    // Adjust query
    instance.on('beforeInit', (ctx) => {
      ctx.query = MwApiBase.normalizeBody(ctx.query) || {}
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
    return this.request.get<MwApiResponse<T>>('', {
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
    return this.request.post<MwApiResponse<T>>('', data, {
      ...this.defaultOptions,
      query: { ...(this.defaultParams as any), ...this.defaultOptions.query },
      ...options,
    })
  }

  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams,
    postOptions?: { retry?: number; noCache?: boolean }
  ): Promise<{
    result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'
    token?: string
    reason?: {
      code: string
      text: string
    }
    lguserid: number
    lgusername: string
  }> {
    this.defaultOptions.credentials = 'include'

    postOptions = postOptions || {}
    postOptions.retry ??= 3

    if (postOptions.retry < 1) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.LOGIN_RETRY_LIMIT_EXCEEDED,
        'The limit of the number of times to automatically re-login has been exceeded'
      )
    }

    // FIXME: This is ugly
    let data: any
    try {
      const res = await this.postWithToken(
        'login',
        {
          action: 'login',
          lgname,
          lgpassword,
          ...params,
        },
        { tokenName: 'lgtoken', ...postOptions }
      )
      if (res?.data?.login) {
        data = res.data
      } else {
        throw res
      }
    } catch (e: any) {
      if (e instanceof WikiSaikouError) {
        throw e
      } else if (e?.ok === false) {
        return this.login(lgname, lgpassword, params, {
          ...postOptions,
          noCache: true,
          retry: postOptions.retry - 1,
        })
      } else {
        throw new WikiSaikouError(
          WikiSaikouErrorCode.HTTP_ERROR,
          "The server returns an error, but it doesn't seem to be caused by MediaWiki",
          e
        )
      }
    }

    if (data?.login?.result !== 'Success') {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.LOGIN_FAILED,
        data?.login?.reason?.text ||
          data?.login?.result ||
          'Login failed with unknown reason',
        data
      )
    }
    return data.login
  }
  async getUserInfo() {
    const { data } = await this.get<{
      query: {
        userinfo: {
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
      }
    }>({
      action: 'query',
      meta: 'userinfo',
      uiprop: ['groups', 'rights', 'blockinfo'],
    })
    return data?.query?.userinfo
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
    options?: { tokenName?: string; retry?: number; noCache?: boolean }
  ): Promise<FexiosFinalContext<MwApiResponse<T>>> {
    const { tokenName = 'token', retry = 3, noCache = false } = options || {}

    if (retry < 1) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
        'The limit of the number of times to automatically re-acquire the token has been exceeded'
      )
    }

    const token = await this.token(tokenType, noCache)

    const doRetry = () =>
      this.postWithToken(tokenType, body, {
        tokenName,
        retry: retry - 1,
        noCache: true,
      })

    return this.post<MwApiResponse<T>>({
      [tokenName]: token,
      ...body,
    })
      .then((ctx) => {
        const data = ctx.data
        if (MwApiBase.isBadTokenError(data)) {
          return doRetry()
        }
        return ctx
      })
      .catch((err) => {
        const data = err.data
        if (MwApiBase.isBadTokenError(data) || err?.ok === false) {
          return doRetry()
        } else if (typeof data === 'object' && data !== null) {
          return Promise.reject(data)
        } else {
          throw new WikiSaikouError(
            WikiSaikouErrorCode.HTTP_ERROR,
            'The server returns an error, but it doesn’t seem to be caused by MediaWiki',
            err
          )
        }
      })
  }
  postWithEditToken<T = any>(body: MwApiParams) {
    return this.postWithToken<T>('csrf', body)
  }

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

  private static extractResponseDataFromAny<T = any>(
    data?: any
  ): T | undefined {
    return data?.response?.data || data?.data || data || undefined
  }

  static isMediaWikiApiError(data?: any) {
    const r = MwApiBase.extractResponseDataFromAny<MwApiResponse>(data)
    return (
      typeof r === 'object' && r !== null && ('error' in r || 'errors' in r)
    )
  }
  isMediaWikiApiError = MwApiBase.isMediaWikiApiError

  static extractMediaWikiErrors(data?: any): MwApiResponseError[] {
    const r = MwApiBase.extractResponseDataFromAny<MwApiResponse>(data)
    if (typeof r !== 'object' || r === null) {
      return []
    }
    const error = r?.error
    const errors = r?.errors
    const result: MwApiResponseError[] = []
    if (error) {
      result.push(error)
    }
    if (Array.isArray(errors)) {
      result.push(...errors)
    }
    return result
  }
  extractMediaWikiErrors = MwApiBase.extractMediaWikiErrors

  static isBadTokenError(data?: any) {
    const errors = MwApiBase.extractMediaWikiErrors(data)
    return (
      errors.some((i) => i.code === 'badtoken') ||
      ['NeedToken', 'WrongToken'].includes(data?.login?.result)
    )
  }
  isBadTokenError = MwApiBase.isBadTokenError
}

// Errors
export enum WikiSaikouErrorCode {
  HTTP_ERROR = 'HTTP_ERROR',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGIN_RETRY_LIMIT_EXCEEDED = 'LOGIN_RETRY_LIMIT_EXCEEDED',
  TOKEN_RETRY_LIMIT_EXCEEDED = 'TOKEN_RETRY_LIMIT_EXCEEDED',
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
  string | number | string[] | undefined | boolean | File | Blob
>
export type MwTokenName =
  | 'createaccount'
  | 'csrf'
  | 'login'
  | 'patrol'
  | 'rollback'
  | 'userrights'
  | 'watch'
export type MwApiResponse<T = any> = T & {
  batchcomplete?: string
  continue?: {
    [key: string]: string
    continue: string
  }
  limits?: Record<string, number>
  error?: MwApiResponseError
  errors?: MwApiResponseError[]
  warnings?: Record<string, { warnings: string }>
}
export interface MwApiResponseError {
  code: string
  info: string
  docref?: string
}
