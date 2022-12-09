/**
 * MediaWiki Api for Axios
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { Ref, ref, computed, ComputedRef } from '@vue/reactivity'

export class MediaWikiApi {
  baseURL: Ref<string>
  #defaultOptions: Ref<AxiosRequestConfig<any>>
  #defaultParams: Ref<ApiParams>
  #tokens: Record<string, string>
  #axiosInstance: ComputedRef<AxiosInstance>
  cookies: Record<string, string> = {}

  constructor(baseURL = '/api.php', options?: AxiosRequestConfig) {
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

    // Init AxiosInstance
    this.#axiosInstance = computed(() => {
      const instance = MediaWikiApi.createAxiosInstance({
        baseURL: this.baseURL.value,
        params: this.#defaultParams.value,
        options: this.#defaultOptions.value,
      })
      // Cookie handling for nodejs
      if (!('document' in globalThis)) {
        instance.interceptors.response.use((ctx) => {
          const rawCookies = ctx.headers['set-cookie']
          rawCookies?.forEach((i) => {
            const [name, value = ''] = i.split(';')[0].split('=')
            this.cookies[name] = value
          })
          return ctx
        })
        instance.interceptors.request.use((ctx) => {
          ctx.headers = ctx.headers || {}
          ctx.headers['cookie'] = ''
          for (const name in this.cookies) {
            ctx.headers['cookie'] += `${name}=${this.cookies[name]};`
          }
          return ctx
        })
      }
      return instance
    })
  }

  static adjustParamValue(item: ApiParams) {
    if (Array.isArray(item)) {
      return item.join('|')
    } else if (typeof item === 'boolean') {
      return item ? '' : undefined
    } else {
      return item
    }
  }
  static createAxiosInstance({
    baseURL,
    params,
    options,
  }: {
    baseURL: string
    params: ApiParams
    options: AxiosRequestConfig
  }) {
    const instance = axios.create({
      baseURL,
      timeout: 30 * 1000,
      params,
      ...options,
    })
    instance.interceptors.request.use((ctx) => {
      Object.keys(ctx.params).forEach((item) => {
        ctx.params[item] = MediaWikiApi.adjustParamValue(ctx.params[item])
      })
      return ctx
    })
    instance.interceptors.request.use((ctx) => {
      if (ctx.method?.toLowerCase() === 'post') {
        ctx.data = {
          ...ctx.params,
          ...ctx.data,
        }
        ctx.params = {
          format: ctx.params?.format,
          formatversion: ctx.params?.formatversion,
          origin:
            encodeURIComponent(ctx.params?.origin || '')?.replace(
              /\./g,
              '%2E'
            ) || undefined,
        }
        const formData = new FormData()
        for (const key in ctx.data) {
          const data = MediaWikiApi.adjustParamValue(ctx.data[key])
          if (typeof data === 'undefined') continue
          formData.append(key, data.toString())
        }
        ctx.data = formData
      }
      return ctx
    })
    instance.interceptors.response.use((ctx) => {
      if (ctx.data?.error || ctx.data?.errors?.length) {
        return Promise.reject(ctx)
      }
      return ctx
    })
    return instance
  }

  /** Syntactic Sugar */
  // AxiosInstance
  get ajax() {
    return this.#axiosInstance.value
  }
  // userOptions
  get defaultOptions() {
    return this.#defaultOptions.value
  }
  set defaultOptions(options: AxiosRequestConfig) {
    this.#defaultOptions.value = options
  }
  // defaultParams
  get defaultParams() {
    return this.#defaultParams.value
  }
  set defaultParams(params: ApiParams) {
    this.#defaultParams.value = params
  }

  /** Base methods encapsulation */
  get<T = any>(
    params: ApiParams,
    options?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.ajax.get('', {
      params,
      ...options,
    })
  }
  post<T = any>(
    data: ApiParams,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.ajax.post('', data, config)
  }

  async login(
    username: string,
    password: string,
    params?: ApiParams
  ): Promise<{ status: 'PASS' | 'FAIL'; username: string }> {
    this.defaultOptions.withCredentials = true
    const { data } = await this.postWithToken(
      'login',
      {
        action: 'clientlogin',
        loginreturnurl: this.baseURL.value,
        username,
        password,
        ...params,
      },
      { tokenName: 'logintoken' }
    )
    return data.clientlogin
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
    const { data } = await this.get({
      action: 'query',
      meta: 'userinfo',
      uiprop: ['groups', 'rights', 'blockinfo'],
    })
    return data?.query?.userinfo
  }

  /** Token Handler */
  async getTokens(type: TokenType[] = ['csrf']) {
    this.defaultOptions.withCredentials = true
    const { data } = await this.get({
      action: 'query',
      meta: 'tokens',
      type,
    })
    this.#tokens = { ...this.#tokens, ...data.query.tokens }
    return this.#tokens
  }
  async token(type: TokenType = 'csrf', noCache = false) {
    if (!this.#tokens[`${type}token`] || noCache) {
      delete this.#tokens[`${type}token`]
      await this.getTokens([type])
    }
    return this.#tokens[`${type}token`]
  }

  async postWithToken(
    tokenType: TokenType,
    body: ApiParams,
    options?: { tokenName?: string; retry?: number; noCache?: boolean }
  ): Promise<AxiosResponse<any>> {
    const { tokenName = 'token', retry = 3, noCache = false } = options || {}
    if (retry < 1) {
      return Promise.reject({
        error: {
          code: 'internal-retry-limit-exceeded',
          info: 'The limit of the number of times to automatically re-acquire the token has been exceeded',
        },
      })
    }
    return this.post({
      [tokenName]: await this.token(tokenType, noCache),
      ...body,
    })
      .finally(() => {
        delete this.#tokens[`${tokenType}token`]
      })
      .catch(({ data }) => {
        if ([data?.errors?.[0].code, data?.error?.code].includes('badtoken')) {
          return this.postWithToken(tokenType, body, {
            tokenName,
            retry: retry - 1,
            noCache: true,
          })
        }
        return Promise.reject(data)
      })
  }
  postWithEditToken(body: Record<string, string | number | string[]>) {
    return this.postWithToken('csrf', body)
  }

  async getMessages(ammessages: string[], amlang = 'zh', options: ApiParams) {
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

  async parseWikitext(wikitext: string, page?: string): Promise<string> {
    const { data } = await this.post({
      action: 'parse',
      page,
      text: wikitext,
    })
    return data.parse.text
  }
}

export class MediaWikiForeignApi extends MediaWikiApi {
  constructor(baseURL = '/api.php', options?: AxiosRequestConfig) {
    super(baseURL, {
      withCredentials: true,
      ...options,
    })
    this.defaultParams = {
      ...this.defaultParams,
      origin: location.origin,
    }
  }
}

type ValueOf<T> = T[keyof T]
type ApiParams = Record<
  string,
  string | number | string[] | undefined | boolean
>
type TokenType =
  | 'createaccount'
  | 'csrf'
  | 'login'
  | 'patrol'
  | 'rollback'
  | 'userrights'
  | 'watch'
