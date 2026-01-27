import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { MediaWikiRestApi } from '@/browser.js'
import { MOCK_API_ENDPOINT_URL } from './__mock__/mwApiServer.js'
;(globalThis as any).location = MOCK_API_ENDPOINT_URL

describe('MediaWiki REST client (Browser)', () => {
  it('normalizes protocol-relative baseURL using current protocol', () => {
    const api = new MediaWikiRestApi({
      baseURL: '//example.org/w/rest.php/',
    })
    expect((api.http.baseConfigs as any).baseURL).to.equal(
      'https://example.org/w/rest.php/'
    )
  })
})
