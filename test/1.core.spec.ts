import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi } from 'wiki-saikou'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_SITE_NAME,
  mockFetch,
} from './mockFetch.js'

const api = new MediaWikiApi({
  baseURL: MOCK_API_ENDPOINT_URL.href,
  defaultOptions: {
    headers: {
      'api-user-agent': env.API_USER_AGENT || '',
    },
    fetch: mockFetch,
  },
})

describe('MediaWikiApi', () => {
  it('[CORE] normalize param values', () => {
    expect(MediaWikiApi.normalizeParamValue(true)).to.eq('1')
    expect(MediaWikiApi.normalizeParamValue(false)).to.be.undefined
    expect(MediaWikiApi.normalizeParamValue(123)).to.eq('123')
    expect(MediaWikiApi.normalizeParamValue(['foo', 'bar'])).to.eq('foo|bar')
    if (globalThis.File) {
      const fakeFile = new File(['foo'], 'foo.txt', { type: 'text/plain' })
      expect(MediaWikiApi.normalizeParamValue(fakeFile)).to.instanceOf(File)
    }
  })

  it('[CORE] normalize body (plain object)', () => {
    const data = {
      string: 'foo',
      number: 123,
      boolean: true,
      falsy: false,
      undefined: undefined,
      null: null,
      array: ['foo', 'bar'],
    }
    const normalized = MediaWikiApi.normalizeBody(data)!
    expect(normalized).to.be.an('URLSearchParams')
    expect(normalized.get('string')).to.eq('foo')
    expect(normalized.get('number')).to.eq('123')
    expect(normalized.get('boolean')).to.eq('1')
    expect(normalized.get('falsy')).toBeNull()
    expect(normalized.get('undefined')).toBeNull()
    expect(normalized.get('null')).toBeNull()
    expect(normalized.get('array')).to.eq('foo|bar')
  })

  it('[GET] siteinfo', async () => {
    const { data } = await api.get({ action: 'query', meta: 'siteinfo' })
    expect(data.query.general).to.be.an('object')
    const info = data.query.general
    expect(info.sitename).to.eq(MOCK_MW_SITE_NAME)
    expect(info.servername).to.eq(MOCK_API_ENDPOINT_URL.hostname)
  })

  it('[GET] userinfo', async () => {
    const info = await api.getUserInfo()
    expect(info.id).to.be.a('number')
    expect(info.name).to.be.an('string')
  })

  it('[GET] array as param', async () => {
    const { data } = await api.get({
      action: 'query',
      meta: ['siteinfo', 'userinfo'],
    })
    expect(data.query.general).to.not.be.undefined
    expect(data.query.userinfo).to.not.be.undefined
  })

  it('[POST] parse', async () => {
    const { data } = await api.post({
      action: 'parse',
      title: 'Custom Page',
      text: `'''bold''' ''italic'' [[Mainpage]] {{PAGENAME}}`,
      prop: ['text', 'wikitext', 'links'],
      disablelimitreport: 1,
    })
    expect(data.parse.title).to.eq('Custom Page')
    expect(data.parse.text).to.includes('<b>bold</b>')
    expect(data.parse.text).to.includes('<i>italic</i>')
    expect(data.parse.links).to.be.an('array')
  })
})
