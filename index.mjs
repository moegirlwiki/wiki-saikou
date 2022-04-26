/**
 * @author Dragon-Fish <dragon-fish@qq.com>
 */

import axios, { AxiosResponse } from 'axios'

export class MediaWikiApi {
  constructor(endpoint = '/api.php') {
    this.endpoint = endpoint
    this.request = this.useAJAX()
    this.tokens = {}
  }

  // AJAX
  useAJAX() {
    return axios.create({
      baseURL: endpoint,
      timeout: 30 * 1000,
      params: {
        action: 'query',
        errorformat: 'plaintext',
        format: 'json',
        formatversion: 2,
        origin: location.origin,
        '*': '',
      },
      withCredentials: true,
    })
  }

  /**
   *
   * @param {Record<string, any>} params
   * @returns {Promise<AxiosResponse<any>>}
   */
  get(params, options) {
    return this.request.get(
      '',
      {
        params,
      },
      options
    )
  }

  /**
   *
   * @returns {Promise<{ id: number; name: string; groups: string[]; rights: string[]; blockid?: number; blockedby?: string; blockedbyid?: number; blockedtimestamp?: string; blockreason?: string; blockexpiry?: string }>}
   */
  async getUserInfo() {
    const { data } = await this.get({
      action: 'query',
      meta: 'userinfo',
      uiprop: ['groups', 'rights', 'blockinfo'],
    })
    return data?.query?.userinfo
  }

  async initTokens(type = ['csrf']) {
    const { data } = await this.get({
      action: 'query',
      meta: 'tokens',
      type: type.join('|'),
    })
    this.tokens = { ...this.tokens, ...data.query.tokens }
    return this.tokens
  }

  async token(type = 'csrf', noCache = false) {
    if (!this.tokens[`${type}token`] || noCache) {
      await this.initTokens(type)
    }
    return this.tokens[`${type}token`]
  }

  /**
   * @param {Record<string, any>} body
   * @returns {Promise<AxiosResponse<any>>}
   */
  post(body) {
    return this.request.post('', {
      body,
    })
  }

  /**
   * @param {'csrf' | 'patrol' | 'watch'} type
   * @param {Record<string, any>} body
   * @returns {Promise<AxiosResponse<any>>}
   */
  async postWithToken(type, body) {
    return this.post({ token: await this.token(type), ...body })
  }

  /**
   * @param {Record<string, any>} body
   */
  postWithEditToken(body) {
    return this.postWithToken('csrf', body)
  }

  /**
   *
   * @param {string[]} ammessages
   * @param {ApiQueryAllMessagesParams} options
   * @returns {Promise<Record<string, string>>}
   */
  async getMessages(ammessages, options) {
    const { data } = await this.get({
      action: 'query',
      meta: 'allmessages',
      ammessages,
      amlang: config.wgUserLanguage,
      ...options,
    })
    const result = {}
    data.query.allmessages.forEach(function (
      /** @type {{ missing?: boolean name: string content: string }} obj */ obj
    ) {
      if (!obj.missing) {
        result[obj.name] = obj.content
      }
    })
    return result
  }

  /**
   *
   * @param {string} wikitext
   * @param {string?} page
   * @returns {Promise<string>}
   */
  async parseWikitext(wikitext, page) {
    const { data } = await this.post({
      action: 'parse',
      contentmodel: 'wikitext',
      page,
      text: wikitext,
    })
    return data.parse.text
  }
}
