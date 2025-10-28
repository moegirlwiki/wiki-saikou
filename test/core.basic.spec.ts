import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi } from 'wiki-saikou'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_SITE_NAME,
  mockFetch,
} from './__mock__/mwApiServer.js'

const api = new MediaWikiApi({
  baseURL: MOCK_API_ENDPOINT_URL.href,
  fexiosConfigs: {
    headers: {
      'api-user-agent': env.API_USER_AGENT || '',
    },
    fetch: mockFetch,
  },
})

describe('MediaWikiApi Core (basic)', () => {
  it('[GET] siteinfo', async () => {
    const { data } = await api.get({ action: 'query', meta: 'siteinfo' })
    expect(data.query.general).to.be.an('object')
    const info = data.query.general
    expect(info.sitename).to.eq(MOCK_MW_SITE_NAME)
    expect(info.servername).to.eq(MOCK_API_ENDPOINT_URL.hostname)
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

  it('resolve legacy init options', () => {
    const legacy = new MediaWikiApi(
      'foo',
      { query: { bar: 'bar' } },
      { baz: 'baz' }
    )
    const modern = new MediaWikiApi({
      baseURL: 'foo',
      fexiosConfigs: {
        query: { bar: 'bar' },
      },
      defaultParams: { baz: 'baz' },
    })
    expect(legacy.config).to.deep.equal(modern.config)
  })
})
