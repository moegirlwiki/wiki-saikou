import 'dotenv/config'
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { env } from 'process'
import { MediaWikiApi, WikiSaikouErrorCode } from '../src/index'

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

  it('Login success', async () => {
    const login = await api.login(username, password).catch((e) => {
      console.error('LOGIN FAIL', e)
      return Promise.reject(e)
    })
    expect(login.result).to.equal('Success')
    expect(login.lgusername).to.equal(username)
  })

  it('Should throw an error if login fails', async () => {
    try {
      await api.login('invalid', 'credentials')
    } catch (e) {
      expect(e).to.be.an('error')
      expect(e?.code).to.equal(WikiSaikouErrorCode.LOGIN_FAILED)
    }
  })
})
