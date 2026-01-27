import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { WikiSaikouErrorCode } from '@/node.js'
import {
  MOCK_API_ENDPOINT_URL,
  createMockServer,
} from './__mock__/mwApiServer.js'
import { MediaWikiRestApi } from '@/node.js'

const MOCK_REST_ENDPOINT = MOCK_API_ENDPOINT_URL.href.replace(
  /\/api\.php$/i,
  '/rest.php/'
)

describe('MediaWiki REST client (rest.php)', () => {
  function expectInvalidRestEndpoint(ctor: () => unknown) {
    try {
      ctor()
      throw new Error('Expected MediaWikiRestApi constructor to throw')
    } catch (e: any) {
      expect(e?.name).to.equal('WikiSaikouError')
      expect(e?.code).to.equal(WikiSaikouErrorCode.INVALID_REST_ENDPOINT)
    }
  }

  it('throws INVALID_REST_ENDPOINT when baseURL is not provided (Node.js)', () => {
    expectInvalidRestEndpoint(() => new MediaWikiRestApi({} as any))
  })

  it('throws INVALID_REST_ENDPOINT when baseURL is relative/invalid (Node.js)', () => {
    expectInvalidRestEndpoint(
      () => new MediaWikiRestApi({ baseURL: '/rest.php' } as any)
    )
    expectInvalidRestEndpoint(
      () => new MediaWikiRestApi({ baseURL: 'rest.php' } as any)
    )
  })

  it('replaces {placeholders} via pathParams and keeps query', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_REST_ENDPOINT,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    const { data } = await api.get<{
      ok: boolean
      titleDecoded: string
      pathname: string
      query: Record<string, string>
    }>('/v1/page/{title}', {
      pathParams: { title: 'Main Page' },
      query: { search: 'baz' },
    })

    expect(data.ok).to.equal(true)
    expect(data.titleDecoded).to.equal('Main Page')
    // Ensure it was URL-encoded in the actual request path.
    expect(data.pathname).to.equal('/rest.php/v1/page/Main%20Page')
    expect(data.query.search).to.equal('baz')
  })

  it('throws when path placeholder is not provided', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_REST_ENDPOINT,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    await expect(api.get('/v1/page/{title}')).rejects.toMatchObject({
      name: 'WikiSaikouError',
      code: WikiSaikouErrorCode.INVALID_REST_PATH,
    })
  })

  it('supports non-JSON REST responses (e.g. HTML)', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_REST_ENDPOINT,
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    const { data } = await api.get('/v1/html')
    expect(data).to.be.a('string')
    expect(String(data)).to.includes('<html>')
    expect(String(data)).to.includes('Mock HTML')
  })

  it('ignores baseURL query/hash (does not leak into requests)', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiRestApi({
      baseURL: MOCK_REST_ENDPOINT + '?foo=bar#hash',
      fexiosConfigs: {
        headers: {
          'api-user-agent': env.API_USER_AGENT || '',
        },
        fetch: mockServer.mockFetch,
      },
    })

    const { data } = await api.get<{
      query: Record<string, string>
    }>('/v1/page/{title}', {
      pathParams: { title: 'Main Page' },
      query: { search: 'baz' },
    })

    // Ensure only the request query is present (baseURL query/hash shouldn't leak).
    expect(data.query.search).to.equal('baz')
    expect((data.query as any).foo).to.equal(undefined)
  })
})
