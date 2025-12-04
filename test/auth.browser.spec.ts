import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi as BrowserApi, WikiSaikouErrorCode } from '@/browser.js'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_USERNAME,
  MOCK_MW_PASSWORD,
  mockFetch,
} from './__mock__/mwApiServer.js'
;(globalThis as any).location = MOCK_API_ENDPOINT_URL

const username = MOCK_MW_USERNAME
const password = MOCK_MW_PASSWORD

describe('Authorization (Browser)', () => {
  it('clientLogin success', async () => {
    const api = new BrowserApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockFetch,
      },
    })

    const login = await api.clientLogin(username, password)
    expect(login.status).to.equal('PASS')
  })

  it('clientLogin failure', {}, async () => {
    const api = new BrowserApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: mockFetch,
      },
    })

    try {
      await api.clientLogin('invalid', 'credentials')
    } catch (e: any) {
      expect(e).to.be.an('error')
      expect(e?.code).to.equal(WikiSaikouErrorCode.LOGIN_FAILED)
    }
  })

  it('clientLogin with logincontinue=true skips return url auto-fill', async () => {
    const api = new BrowserApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: mockFetch,
      },
    })

    const login = await api.clientLogin(username, password, {
      logincontinue: true,
    })
    expect(login.status).to.equal('PASS')
  })

  it('throwOnApiError=true still throws WikiSaikouError on FAIL', async () => {
    const api = new BrowserApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: mockFetch,
      },
      throwOnApiError: true,
    })

    try {
      await api.clientLogin('invalid', 'credentials')
    } catch (e: any) {
      // Browser clientLogin FAIL is mapped to WikiSaikouError(LOGIN_FAILED)
      expect(e?.name).to.equal('WikiSaikouError')
      expect(e?.code).to.equal(WikiSaikouErrorCode.LOGIN_FAILED)
    }
  })
})
