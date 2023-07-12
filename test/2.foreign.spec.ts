import 'dotenv/config'
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { env } from 'process'
import { MediaWikiForeignApi } from '../src/index'
;(globalThis as any).location = new URL('https://zh.moegirl.org.cn/Mainpage')

const api = new MediaWikiForeignApi('https://commons.moegirl.org.cn/api.php', {
  headers: {
    'api-user-agent': env.MOEGIRL_API_USER_AGENT || '',
    origin: location.origin,
  },
})

describe('MediaWikiForeignApi', () => {
  it('[GET] siteinfo', async () => {
    const { data, headers } = await api
      .get({
        action: 'query',
        meta: 'siteinfo',
      })
      .catch((e) => {
        console.warn(e)
        return Promise.reject(e)
      })
    expect(headers['access-control-allow-origin']).to.equal(location.origin)
    expect(data.query.general.sitename).to.equal('萌娘共享')
  })

  it('[GET] array as param', async () => {
    const { data, headers } = await api.get({
      action: 'query',
      meta: ['siteinfo', 'userinfo'],
    })
    expect(headers['access-control-allow-origin']).to.equal(location.origin)
    expect(data.query.general).to.not.be.undefined
    expect(data.query.userinfo).to.not.be.undefined
  })

  it('[POST] parse', async () => {
    const { data, headers } = await api
      .post({
        action: 'parse',
        title: 'Custom Page',
        text: `'''bold''' ''italic'' [[Mainpage]] {{PAGENAME}}`,
        prop: ['text', 'wikitext', 'links'],
        disablelimitreport: 1,
      })
      .catch((e) => {
        console.warn(e)
        return Promise.reject(e)
      })
    // console.info({ data, headers })
    expect(headers['access-control-allow-origin']).to.equal(location.origin)
    expect(data.parse.title).to.eq('Custom Page')
    expect(data.parse.text).to.includes('<b>bold</b>')
    expect(data.parse.text).to.includes('<i>italic</i>')
    expect(data.parse.links).to.be.an('array')
  })
})
