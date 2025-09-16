import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiForeignApi } from 'wiki-saikou/browser'
;(globalThis as any).location = new URL('https://wiki.epb.wiki/Mainpage')

const api = new MediaWikiForeignApi('https://common.epb.wiki/api.php', {
  headers: {
    'api-user-agent': env.API_USER_AGENT || '',
    origin: location.origin,
  },
})

describe('MediaWikiForeignApi', () => {
  it('[GET] siteinfo', async () => {
    const { data, response } = await api
      .get({
        action: 'query',
        meta: 'siteinfo',
      })
      .catch((e) => {
        console.warn(e)
        return Promise.reject(e)
      })
    expect(response.headers.get('access-control-allow-origin')).to.equal(
      location.origin
    )
    expect(data.query.general.sitename).to.equal('Project-EPB Commons')
  })

  it('[GET] array as param', async () => {
    const { data, response } = await api.get({
      action: 'query',
      meta: ['siteinfo', 'userinfo'],
    })
    expect(response.headers.get('access-control-allow-origin')).to.equal(
      location.origin
    )
    expect(data.query.general).to.not.be.undefined
    expect(data.query.userinfo).to.not.be.undefined
  })

  it('[POST] parse', async () => {
    const { data, response } = await api
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
    expect(response.headers.get('access-control-allow-origin')).to.equal(
      location.origin
    )
    expect(data.parse.title).to.eq('Custom Page')
    expect(data.parse.text).to.includes('<b>bold</b>')
    expect(data.parse.text).to.includes('<i>italic</i>')
    expect(data.parse.links).to.be.an('array')
  })
})
