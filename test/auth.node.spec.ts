import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi, WikiSaikouErrorCode } from 'wiki-saikou/node'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_USERNAME,
  MOCK_MW_PASSWORD,
  mockFetch,
} from './__mock__/mwApiServer.js'

const username = MOCK_MW_USERNAME
const password = MOCK_MW_PASSWORD

describe(
  'Authorization (Node)',
  {
    sequential: true,
  },
  () => {
    const api = new MediaWikiApi(MOCK_API_ENDPOINT_URL.href, {
      headers: {
        'api-user-agent': env.API_USER_AGENT || '',
      },
      fetch: mockFetch,
    })

    it('Get login token', async () => {
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

    it('Fetch csrf token after login', async () => {
      // Ensure logged in
      const login = await api.login(username, password)
      expect(login.result).to.equal('Success')

      const token = await api.getToken('csrf')
      expect(token).to.be.a('string')
    })

    it('Edit without login should return notloggedin in body', async () => {
      const unauthApi = new MediaWikiApi(MOCK_API_ENDPOINT_URL.href, {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockFetch,
      })

      const { data } = await unauthApi.postWithEditToken({
        action: 'edit',
        title: 'User:Sandbox/unauth',
        text: 'unauthorized edit',
      })

      expect(data.error?.code).to.equal('notloggedin')
    })
  }
)
