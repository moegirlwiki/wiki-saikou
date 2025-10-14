import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiForeignApi } from 'wiki-saikou/browser'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_SITE_NAME,
  mockFetch,
} from './mockFetch.ts'

// 模拟浏览器环境的 location 对象
const mockLocation = new URL('https://test-origin.example.com/Mainpage')
;(globalThis as any).location = mockLocation

const api = new MediaWikiForeignApi(MOCK_API_ENDPOINT_URL.href, {
  headers: {
    'api-user-agent': env.API_USER_AGENT || '',
    origin: mockLocation.origin,
  },
  fetch: mockFetch,
})

describe('MediaWikiForeignApi', () => {
  it('[GET] siteinfo', async () => {
    const { data, response } = await api.get({
      action: 'query',
      meta: 'siteinfo',
    })
    expect(response.headers.get('access-control-allow-origin')).to.equal(
      mockLocation.origin
    )
    expect(data.query.general.sitename).to.equal(MOCK_MW_SITE_NAME)
  })
})
