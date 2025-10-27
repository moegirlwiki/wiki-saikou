import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi as NodeApi, WikiSaikouErrorCode } from 'wiki-saikou'
import { MediaWikiApi as BrowserApi } from 'wiki-saikou/browser'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_USERNAME,
  MOCK_MW_PASSWORD,
  mockFetch,
} from './mockFetch.js'
;(globalThis as any).location = MOCK_API_ENDPOINT_URL

const username = MOCK_MW_USERNAME
const password = MOCK_MW_PASSWORD

describe('Authorization', () => {
  const api = new NodeApi(MOCK_API_ENDPOINT_URL.href, {
    headers: {
      'api-user-agent': env.API_USER_AGENT || '',
    },
    fetch: mockFetch,
  })

  describe(
    'Node.js',
    {
      sequential: true,
    },
    () => {
      it('Get token', async () => {
        const token = await api.token('login')
        expect(token).to.be.a('string')
      })

      it('Login success', async () => {
        const login = await api.login(username, password)
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
    }
  )

  describe('Browser', () => {
    const api = new BrowserApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: mockFetch,
      },
    })

    it('clientLogin', async () => {
      const login = await api.clientLogin(username, password)
      expect(login.status).to.equal('PASS')
    })

    it('Should throw an error if clientLogin fails', {}, async () => {
      try {
        await api.clientLogin('invalid', 'credentials')
      } catch (e: any) {
        expect(e).to.be.an('error')
        expect(e?.code).to.equal(WikiSaikouErrorCode.LOGIN_FAILED)
      }
    })
  })
})
