import 'dotenv/config'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { env } from 'process'
import { MediaWikiApi, WikiSaikouErrorCode } from 'wiki-saikou'
import type { TokenRetryOptions } from '../src/utils/with-retry.js'
import { beforeAll } from 'vitest'

const username = env.MW_USERNAME || ''
const password = env.MW_PASSWORD || ''
const fakeLoginToken = 'bf4666efe3171c3424394e31766f317c68c9338b+\\'

describe(
  'Authorization',
  {
    sequential: true,
  },
  () => {
    let api: MediaWikiApi
    beforeAll(async () => {
      api = new MediaWikiApi('https://wiki.epb.wiki/api.php', {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
      })
    })

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

    it('Should throw an error if login fails', {}, async () => {
      try {
        await api.login('invalid', 'credentials')
      } catch (e: any) {
        expect(e).to.be.an('error')
        expect(e?.code).to.equal(WikiSaikouErrorCode.LOGIN_FAILED)
      }
    })

    it('Should retry automatically when token expires', async () => {
      const api = new MediaWikiApi('https://wiki.epb.wiki/api.php', {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
      })
      Object.defineProperty(api, 'tokens', {
        value: {
          logintoken: fakeLoginToken,
        },
      })
      let tokenErrorCount = 0
      const login = await api.login(
        username,
        password,
        {},
        {
          onTokenError(err, retryCount) {
            tokenErrorCount++
          },
        }
      )
      expect(login.result).to.equal('Success')
      expect(tokenErrorCount).to.greaterThan(0)
    })
  }
)
