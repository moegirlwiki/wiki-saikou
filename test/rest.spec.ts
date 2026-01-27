import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { WikiSaikouErrorCode } from '@/node.js'
import {
  MOCK_API_ENDPOINT_URL,
  createMockServer,
} from './__mock__/mwApiServer.js'
import { MediaWikiRestApi } from '@/node.js'

describe('MediaWikiApi REST wrapper (rest.php)', () => {
  it('replaces {placeholders} via pathParams and keeps query', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    const { data } = await api.rest<{
      ok: boolean
      titleDecoded: string
      pathname: string
      query: Record<string, string>
    }>('GET', '/v1/page/{title}', {
      pathParams: { title: 'Main Page' },
      query: { search: 'baz' },
    })

    expect(data.ok).to.equal(true)
    expect(data.titleDecoded).to.equal('Main Page')
    // Ensure it was URL-encoded in the actual request path.
    expect(data.pathname).to.equal('/rest.php/v1/page/Main%20Page')
    expect(data.query.search).to.equal('baz')
  })

  it('throws when path placeholder is not provided', () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    try {
      api.rest('GET', '/v1/page/{title}')
      throw new Error('Expected rest() to throw')
    } catch (e: any) {
      expect(e?.name).to.equal('WikiSaikouError')
      expect(e?.code).to.equal(WikiSaikouErrorCode.INVALID_REST_PATH)
    }
  })

  it('supports non-JSON REST responses (e.g. HTML)', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    const { data } = await api.rest('GET', '/v1/html')
    expect(data).to.be.a('string')
    expect(String(data)).to.includes('<html>')
    expect(String(data)).to.includes('Mock HTML')
  })

  it('infers rest.php from baseURL with query/hash', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: `${MOCK_API_ENDPOINT_URL.href}?foo=bar#hash`,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    const { data } = await api.rest<{
      query: Record<string, string>
    }>('GET', '/v1/page/{title}', {
      pathParams: { title: 'Main Page' },
      query: { search: 'baz' },
    })

    // Ensure only the request query is present (baseURL query/hash shouldn't leak).
    expect(data.query.search).to.equal('baz')
    expect((data.query as any).foo).to.equal(undefined)
  })

  it('throws when baseURL cannot infer rest.php endpoint', () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: 'https://wiki-saikou.test/w/index.php',
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    try {
      api.rest('GET', '/v1/html')
      throw new Error('Expected rest() to throw')
    } catch (e: any) {
      expect(e?.name).to.equal('WikiSaikouError')
      expect(e?.code).to.equal(WikiSaikouErrorCode.INVALID_REST_ENDPOINT)
    }
  })
})
