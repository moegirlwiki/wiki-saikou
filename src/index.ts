/**
 * MediaWiki Api for Axios
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */

import { Ref, ref, computed, ComputedRef } from '@vue/reactivity'
import {
  LylaAdapterMeta,
  createLyla,
  LylaRequestOptions,
  LylaResponse,
} from './modules/lyla-adapter-fetch'
import { Lyla } from '@lylajs/core'

export class MediaWikiApi {
  baseURL: Ref<string>
  #requestHandler: ComputedRef<Lyla<any, LylaAdapterMeta>>
  #defaultOptions: Ref<LylaRequestOptions>
  #defaultParams: Ref<MwApiParams>
  #tokens: Record<string, string>
  cookies: Record<string, string> = {}

  constructor(baseURL?: string, options?: LylaRequestOptions) {
    // For MediaWiki environment
    if (!baseURL && typeof window === 'object' && (window as any).mediaWiki) {
      const scriptPath: string | undefined = (
        window as any
      ).mediaWiki?.config?.get('wgScriptPath')
      typeof scriptPath === 'string' && (baseURL = `${scriptPath}/api.php`)
    }
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL is undefined')
    }
    // Init
    this.baseURL = ref(baseURL)
    this.#tokens = {}
    this.#defaultParams = ref({})
    this.#defaultOptions = ref({})

    // Set default values
    this.defaultParams = {
      action: 'query',
      errorformat: 'plaintext',
      format: 'json',
      formatversion: 2,
    }
    this.defaultOptions = options || {}

    this.#requestHandler = computed(() => {
      const options: LylaRequestOptions = {
        ...this.#defaultOptions.value,
      }

      options.hooks ??= {}
      options.hooks.onInit ??= []
      options.hooks.onBeforeRequest ??= []
      options.hooks.onAfterResponse ??= []

      // Inject default query params
      options.hooks.onInit?.unshift((ctx) => {
        // @ts-ignore FIXME: Type error during vite build, too bad!
        ctx.query = {
          ...this.#defaultParams.value,
          ...ctx.query,
        }

        // Fix missing baseURL
        !ctx.url && (ctx.url = this.baseURL.value)

        return ctx
      })

      // Handle cookies for Node.js
      if (!('document' in globalThis)) {
        options.hooks.onBeforeRequest.push((ctx) => {
          ctx.headers = ctx.headers || {}
          ctx.headers['cookie'] = Object.keys(this.cookies)
            .map((name) => `${name}=${this.cookies[name]}`)
            .join(';')
          return ctx
        })
        options.hooks.onAfterResponse.push((ctx) => {
          const cookieHeaders = (ctx.detail.headers as Headers).get(
            'set-cookie'
          )
          const rawCookies = cookieHeaders?.split(',').map((i) => i.trim())
          rawCookies?.forEach((i) => {
            const [name, ...value] = i.split(';')[0].split('=')
            this.cookies[name] = value.join('=')
          })
          return ctx
        })
      }

      return MediaWikiApi.createLylaInstance(this.baseURL.value, options)
    })
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
  static createLylaInstance(baseURL: string, options: LylaRequestOptions = {}) {
    options.hooks ??= {}
    options.hooks.onInit ??= []
    options.hooks.onBeforeRequest ??= []
    options.hooks.onAfterResponse ??= []
    options.hooks.onResponseError ??= []

    options.hooks.onInit.push((ctx) => {
      // console.info(
      //   '[onInit] beforeTransform',
      //   ctx.method,
      //   ctx.url,
      //   ctx.query,
      //   ctx.body
      // )

      if (ctx.method?.toLowerCase() !== 'post') {
        return ctx
      }

      // Transform json to formdata
      if (ctx.json) {
        const form = new URLSearchParams('')
        for (const key in ctx.json) {
          const data = MediaWikiApi.normalizeParamValue(ctx.json[key])
          if (typeof data === 'undefined') continue
          form.append(key, '' + data)
        }
        ctx.body = form
        ctx.json = undefined
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
        ctx.query ??= {}
        ctx.query.format ??= '' + body.get('format') || 'json'
        ctx.query.formatversion ??= '' + body.get('formatversion') || '2'
        body.has('origin') && (ctx.query.origin = '' + body.get('origin'))
      }

      return ctx
    })

    // Adjust query
    options.hooks.onInit.push((ctx) => {
      ctx.query ??= {}
      for (const key in ctx.query) {
        const data = MediaWikiApi.normalizeParamValue(ctx.query[key])
        if (typeof data === 'undefined' || data === null) {
          delete ctx.query[key]
        } else if (data !== ctx.query[key]) {
          ctx.query[key] = '' + data
        }
      }

      // console.info('[onInit]', ctx.method?.toUpperCase(), ctx.url, {
      //   query: ctx.query,
      //   body: ctx.body,
      //   headers: ctx.headers,
      // })
      return ctx
    })

    // Adjust origin param
    options.hooks.onBeforeRequest.push((ctx) => {
      const url = new URL(ctx.url!)
      if (url.searchParams.has('origin')) {
        const origin = encodeURIComponent(
          url.searchParams.get('origin') || ''
        ).replace(/\./g, '%2E')
        delete ctx.query
        url.searchParams.delete('origin')
        ctx.url = `${url}${url.search ? '&' : '?'}origin=${origin}`
      }
      return ctx
    })

    // @ts-ignore FIXME: Type error during vite build, too bad!
    const { lyla } = createLyla({
      baseUrl: baseURL,
      ...options,
    })

    return lyla
  }

  /** Syntactic Sugar */
  // request handler
  get request() {
    return this.#requestHandler.value
  }
  // userOptions
  get defaultOptions() {
    return this.#defaultOptions.value
  }
  set defaultOptions(options: LylaRequestOptions) {
    this.#defaultOptions.value = options
  }
  // defaultParams
  get defaultParams() {
    return this.#defaultParams.value
  }
  set defaultParams(params: MwApiParams) {
    this.#defaultParams.value = params
  }

  /** Base methods encapsulation */
  get<T = any>(query: MwApiParams, options?: LylaRequestOptions) {
    return this.request.get<T>(this.baseURL.value, {
      query: query as any,
      ...options,
    })
  }
  post<T = any>(data: MwApiParams, options?: LylaRequestOptions) {
    return this.request.post<T>(this.baseURL.value, {
      json: data,
      ...options,
    })
  }

  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams
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
    this.defaultOptions.withCredentials = true
    const { body } = await this.postWithToken(
      'login',
      {
        action: 'login',
        lgname,
        lgpassword,
        ...params,
      },
      { tokenName: 'lgtoken' }
    )
    if (body?.login?.result !== 'Success') {
      throw new Error(
        body?.login?.reason?.text || body?.login?.result || 'Login failed'
      )
    }
    return body.login
  }
  async getUserInfo(): Promise<{
    id: number
    name: string
    groups: string[]
    rights: string[]
    blockid?: number
    blockedby?: string
    blockedbyid?: number
    blockedtimestamp?: string
    blockreason?: string
    blockexpiry?: string
  }> {
    const { body } = await this.get({
      action: 'query',
      meta: 'userinfo',
      uiprop: ['groups', 'rights', 'blockinfo'],
    })
    return body?.query?.userinfo
  }

  /** Token Handler */
  async getTokens(type: MwTokenName[] = ['csrf']) {
    this.defaultOptions.withCredentials = true
    const { body } = await this.get({
      action: 'query',
      meta: 'tokens',
      type,
    })
    this.#tokens = { ...this.#tokens, ...body.query.tokens }
    return this.#tokens
  }
  async token(type: MwTokenName = 'csrf', noCache = false) {
    if (!this.#tokens[`${type}token`] || noCache) {
      delete this.#tokens[`${type}token`]
      await this.getTokens([type])
    }
    return this.#tokens[`${type}token`]
  }

  async postWithToken<T = any>(
    tokenType: MwTokenName,
    body: MwApiParams,
    options?: { tokenName?: string; retry?: number; noCache?: boolean }
  ): Promise<LylaResponse<T>> {
    const { tokenName = 'token', retry = 3, noCache = false } = options || {}
    if (retry < 1) {
      return Promise.reject({
        error: {
          code: 'WIKI_SAIKOU_TOKEN_RETRY_LIMIT_EXCEEDED',
          info: 'The limit of the number of times to automatically re-acquire the token has been exceeded',
        },
      })
    }
    const token = await this.token(tokenType, noCache)
    return this.post<T>({
      [tokenName]: token,
      ...body,
    }).catch(({ body }) => {
      if (
        [body?.errors?.[0].code, body?.error?.code].includes('badtoken') ||
        ['NeedToken', 'WrongToken'].includes(body?.login?.result)
      ) {
        return this.postWithToken(tokenType, body, {
          tokenName,
          retry: retry - 1,
          noCache: true,
        })
      }
      return Promise.reject(body)
    })
  }
  postWithEditToken<T = any>(body: MwApiParams) {
    return this.postWithToken<T>('csrf', body)
  }

  async getMessages(ammessages: string[], amlang = 'zh', options: MwApiParams) {
    const { body } = await this.get({
      action: 'query',
      meta: 'allmessages',
      ammessages,
      amlang,
      ...options,
    })
    const result: Record<string, string> = {}
    body.query.allmessages.forEach(function (obj: {
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

  async parseWikitext(wikitext: string, page?: string): Promise<string> {
    const { body } = await this.post({
      action: 'parse',
      page,
      text: wikitext,
    })
    return body.parse.text
  }
}

export class MediaWikiForeignApi extends MediaWikiApi {
  constructor(baseURL?: string, options?: LylaRequestOptions) {
    super(baseURL, {
      withCredentials: true,
      ...options,
    })
    this.defaultParams.origin = location.origin
  }
}

// Aliases
export default MediaWikiApi
export { MediaWikiApi as MwApi, MediaWikiForeignApi as ForeignApi }

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
