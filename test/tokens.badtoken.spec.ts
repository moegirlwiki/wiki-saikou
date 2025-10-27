import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi } from 'wiki-saikou'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_USERNAME,
  MOCK_MW_PASSWORD,
  createMockServer,
} from './__mock__/mwApiServer.js'

describe('Tokens (badtoken auto refresh)', () => {
  it('auto refresh on badtoken', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: { 'api-user-agent': env.API_USER_AGENT || '' },
        fetch: mockServer.mockFetch,
      },
    })
    mockServer.enableBadtokenTestMode()
    try {
      const login = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
      expect(login.result).to.equal('Success')
      const initialToken = await api.getToken('csrf')
      const { data } = await api.postWithToken('csrf', {
        action: 'testBadtoken',
      })
      expect(data.success.result).to.equal('Success')
      const newToken = await api.getToken('csrf')
      expect(newToken).to.not.equal(initialToken)
    } finally {
      mockServer.disableBadtokenTestMode()
    }
  })

  it('auto refresh on badtoken when throwOnApiError=true', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: { 'api-user-agent': env.API_USER_AGENT || '' },
        fetch: mockServer.mockFetch,
      },
      throwOnApiError: true,
    })
    mockServer.enableBadtokenTestMode()
    try {
      const login = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
      expect(login.result).to.equal('Success')
      const initialToken = await api.getToken('csrf')
      const { data } = await api.postWithToken('csrf', {
        action: 'testBadtoken',
      })
      expect(data.success.result).to.equal('Success')
      const newToken = await api.getToken('csrf')
      expect(newToken).to.not.equal(initialToken)
    } finally {
      mockServer.disableBadtokenTestMode()
    }
  })
})
