import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi } from '@/node.js'
import {
  MOCK_API_ENDPOINT_URL,
  createMockServer,
} from './__mock__/mwApiServer.js'

describe('MediaWikiApi Core (errors)', () => {
  it('throwOnApiError=true maps API error bodies to MediaWikiApiError', async () => {
    const mockServer = createMockServer()

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
      throwOnApiError: true,
    })

    await expect(api.get({ action: 'testError' })).rejects.toMatchObject({
      name: 'MediaWikiApiError',
      code: 'testerror',
    })

    await expect(
      api.get({ action: 'testError', httpError: 1 })
    ).rejects.toMatchObject({ name: 'MediaWikiApiError', code: 'testerror' })

    await expect(api.post({ action: 'testError' })).rejects.toMatchObject({
      name: 'MediaWikiApiError',
      code: 'testerror',
    })
  })
})
