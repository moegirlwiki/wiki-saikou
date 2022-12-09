import { describe, it } from 'mocha'
import { expect } from 'chai'
import { env } from 'process'
import { MediaWikiApi } from '../src/index'
import FormData from 'form-data'
;(globalThis as any).FormData = FormData

const api = new MediaWikiApi('https://zh.moegirl.org.cn/api.php', {
  headers: {
    'api-user-agent': env.MOEGIRL_API_USER_AGENT || '',
  },
})

const username = env.MOEGIRL_USERNAME || ''
const password = env.MOEGIRL_PASSWORD || ''

describe('Authorization', () => {
  it('Get token', async () => {
    const token = await api.token('login')
    expect(token).to.be.a('string')
  })

  it('Login', async () => {
    const login = await api.login(username, password).catch((e) => {
      console.error('LOGIN FAIL', e.data)
      return Promise.reject(e)
    })
    expect(['PASS', 'FAIL']).to.includes(login.status)
    if (login.status !== 'PASS') {
      return
    }
    const userinfo = await api.getUserInfo()
    expect(userinfo.id).not.to.equal(0)
    expect(userinfo.name).to.equal(username)
  })
})
