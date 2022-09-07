/**
 * @author Dragon-Fish <dragon-fish@qq.com>
 */

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import FormData from 'form-data'

export class MediaWikiApi {
  baseURL: string
  userOptions?: AxiosRequestConfig<any>
  defaultParams: ApiParams
  #tokens: Record<string, string>

  constructor(baseURL = '/api.php', options?: AxiosRequestConfig) {
    this.baseURL = baseURL
    this.userOptions = options
    this.defaultParams = {
      action: 'query',
      errorformat: 'plaintext',
      format: 'json',
      formatversion: 2,
    }
    this.#tokens = {}
  }

  // AJAX
  get ajax() {
    const instance = axios.create({
      baseURL: this.baseURL,
      timeout: 30 * 1000,
      params: this.defaultParams,
      ...this.userOptions,
    })
    instance.interceptors.request.use((ctx) => {
      Object.keys(ctx.params).forEach((item) => {
        if (Array.isArray(ctx.params[item])) {
          ctx.params[item] = ctx.params[item].join('|')
        }
      })
      return ctx
    })
    instance.interceptors.request.use((ctx) => {
      if (ctx.method?.toLowerCase() === 'post') {
        ctx.params = {
          format: ctx.params?.format,
          formatversion: ctx.params?.formatversion,
        }
        const formData = new FormData()
        for (const key in ctx.data) {
          formData.append(
            key,
            Array.isArray(ctx.data[key])
              ? ctx.data[key].join('|')
              : ctx.data[key]
          )
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

  get<T = any>(
    params: ApiParams,
    options?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.ajax.get('', {
      params,
      ...options,
    })
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

  async getTokens(type = ['csrf']) {
    const { data } = await this.get({
      action: 'query',
      meta: 'tokens',
      type: type.join('|'),
    })
    this.#tokens = { ...this.#tokens, ...data.query.tokens }
    return this.#tokens
  }

  async token(type = 'csrf', noCache = false) {
    if (!this.#tokens[`${type}token`] || noCache) {
      await this.getTokens([type])
    }
    return this.#tokens[`${type}token`]
  }

  post<T = any>(
    data: ApiParams,
    config?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    return this.ajax.post('', data, config)
  }

  async postWithToken(
    tokenType: 'csrf' | 'patrol' | 'watch',
    body: ApiParams
  ): Promise<AxiosResponse<any>> {
    return this.post({
      token: await this.token(`${tokenType}Token`),
      ...body,
    }).catch((data) => {
      if (data.code === 'badtoken') {
        delete this.#tokens[`${tokenType}Token`]
        return this.postWithToken(tokenType, body)
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
      contentmodel: 'wikitext',
      page,
      text: wikitext,
    })
    return data.parse.text
  }
}

export class MediaWikiForeignApi extends MediaWikiApi {
  constructor(baseURL = '/api.php', options: any) {
    super(baseURL, {
      withCredentials: true,
      ...options,
    })
    this.defaultParams = {
      ...this.defaultParams,
      origin: location.origin,
      '*': '',
    }
  }
}

type ValueOf<T> = T[keyof T]
type ApiParams = Record<string, string | number | string[] | undefined>
