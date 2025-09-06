import {
  Fexios,
  FexiosConfigs,
  FexiosRequestOptions,
  FexiosFinalContext,
} from 'fexios'

/**
 * MediaWiki Api for Axios
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi {
  readonly version = import.meta.env.__VERSION__
  readonly request: Fexios
  private tokens: Record<string, string>
  readonly cookies: Map<string, string> = new Map()

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
      ...MediaWikiApi.INIT_DEFAULT_PARAMS,
      ...defaultParams,
    }
    this.defaultOptions = {
      responseType: 'json',
      ...defaultOptions,
    }

    const instance = MediaWikiApi.createRequestHandler(this.baseURL)
    this.request = instance

    // Handle cookies for Node.js
    if (!('document' in globalThis)) {
      instance.interceptors.request.use((ctx) => {
        ctx.headers = (ctx.headers as Record<string, string>) || {}
        const validCookies = Array
          .from(this.cookies.entries())
          .filter(([name]) => name
            && !name.match(/[0-9]{2} [A-Za-z]{3} [0-9]{4}/) // Exclude cookies looked like expiration date
            && name !== '')
          .map(([name, value]) => `${name}=${value}`)
        if (validCookies.length > 0) {
          ctx.headers['cookie'] = validCookies.join('; ')
        }
        return ctx
      })
      instance.interceptors.response.use((ctx) => {
        const cookieHeaders = (ctx.rawResponse!.headers as Headers).get(
          'set-cookie'
        )
        const rawCookies = cookieHeaders?.split(',').map((i) => i.trim())
        rawCookies?.forEach((i) => {
          const [name, ...value] = i.split(';')[0].split('=')
          this.cookies.set(name, value.join('='))
        })
        return ctx
      })
    }
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

      if (
        typeof ctx.body === 'object' &&
        ctx.body !== null &&
        !(ctx.body instanceof URLSearchParams) &&
        !(ctx.body instanceof FormData)
      ) {
        const body: any = ctx.body
        Object.keys(body).forEach((key) => {
          const data = MediaWikiApi.normalizeParamValue(body[key])
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
          const data = MediaWikiApi.normalizeParamValue(value)
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
        const data = MediaWikiApi.normalizeParamValue(ctx.query[key])
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
  ): Promise<FexiosFinalContext<T>> {
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

    return this.post<T>({
      [tokenName]: token,
      ...body,
    })
      .then((ctx) => {
        const data = ctx.data
        if (MediaWikiApi.isBadTokenError(data)) {
          return doRetry()
        }
        return ctx
      })
      .catch((err) => {
        const data = err.data
        if (MediaWikiApi.isBadTokenError(data) || err?.ok === false) {
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

  static isBadTokenError(data?: any) {
    return (
      data?.error?.code === 'badtoken' ||
      data?.errors?.some((i: any) => i.code === 'badtoken') ||
      ['NeedToken', 'WrongToken'].includes(data?.login?.result)
    )
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
}

export class MediaWikiForeignApi extends MediaWikiApi {
  constructor(
    baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    super(
      baseURL,
      {
        credentials: 'include',
        mode: 'cors',
        ...defaultOptions,
      },
      {
        origin: location.origin,
        ...defaultParams,
      }
    )
  }
}

// Aliases
export default MediaWikiApi
export { MediaWikiApi as MwApi, MediaWikiForeignApi as ForeignApi }

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
