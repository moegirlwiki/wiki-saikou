import { describe, it } from 'mocha'
import { expect } from 'chai'
import { env } from 'process'
import { MediaWikiApi } from '../src/index'

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php', {
  headers: {
    'api-user-agent': env.MOEGIRL_API_USER_AGENT || '',
  },
})

describe('MediaWikiApi', () => {
  it('[GET] siteinfo', async () => {
    const { body } = await api.get({ action: 'query', meta: 'siteinfo' })
    expect(body.query.general).to.be.an('object')
    const info = body.query.general
    expect(info.sitename).to.eq('萌娘百科')
    expect(info.servername).to.eq('zh.moegirl.org.cn')
  })

  it('[GET] userinfo', async () => {
    const info = await api.getUserInfo()
    expect(info.id).to.be.a('number')
    expect(info.name).to.be.an('string')
  })

  it('[GET] array as param', async () => {
    const { body } = await api.get({
      action: 'query',
      meta: ['siteinfo', 'userinfo'],
    })
    expect(body.query.general).to.not.be.undefined
    expect(body.query.userinfo).to.not.be.undefined
  })

  it('[POST] parse', async () => {
    const { body } = await api.post({
      action: 'parse',
      title: 'Custom Page',
      text: `'''bold''' ''italic'' [[Mainpage]] {{PAGENAME}}`,
      prop: ['text', 'wikitext', 'links'],
      disablelimitreport: 1,
    })
    expect(body.parse.title).to.eq('Custom Page')
    expect(body.parse.text).to.includes('<b>bold</b>')
    expect(body.parse.text).to.includes('<i>italic</i>')
    expect(body.parse.links).to.be.an('array')
  })

  // it('[CORE] reactivity', async () => {
  //   api.baseURL.value = 'https://commons.moegirl.org.cn/api.php'
  //   api.defaultParams = {
  //     key1: 'value1',
  //   }
  //   api.defaultParams.key2 = 'value2'
  //   api.defaultOptions = {
  //     timeout: 114514,
  //   }

  //   expect(api.ajax.defaults.baseURL).to.equal(
  //     'https://commons.moegirl.org.cn/api.php'
  //   )
  //   expect(api.ajax.defaults.params).to.deep.equal({
  //     key1: 'value1',
  //     key2: 'value2',
  //   })
  //   expect(api.ajax.defaults.timeout).to.equal(114514)
  // })
})