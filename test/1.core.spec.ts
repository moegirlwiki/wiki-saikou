import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi } from '../src/index'

const api = new MediaWikiApi('https://wiki.epb.wiki/api.php', {
  headers: {
    'api-user-agent': env.API_USER_AGENT || '',
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

  it('[GET] siteinfo', async () => {
    const { data } = await api.get({ action: 'query', meta: 'siteinfo' })
    expect(data.query.general).to.be.an('object')
    const info = data.query.general
    expect(info.sitename).to.eq('小鱼君和他的朋友们')
    expect(info.servername).to.eq('wiki.epb.wiki')
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
