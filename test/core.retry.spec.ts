import { describe, expect, it } from 'vitest'
import {
  MediaWikiApi,
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from '@/node.js'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_PASSWORD,
  MOCK_MW_USERNAME,
  createMockServer,
} from './__mock__/mwApiServer.js'

async function getActionFromFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<string | null> {
  if (input instanceof Request) {
    if (input.method.toUpperCase() !== 'POST') return null
    const fd = await input.clone().formData()
    return fd.get('action') as string | null
  }
  if (init?.body instanceof FormData) {
    return init.body.get('action') as string | null
  }
  return null
}

function getMethodFromFetchArgs(
  input: RequestInfo | URL,
  init?: RequestInit
): string {
  if (input instanceof Request) {
    return input.method.toUpperCase()
  }
  return (init?.method || 'GET').toUpperCase()
}

describe('MediaWikiApi transport retry', () => {
  it('postWithToken retries on fetch failed during post and succeeds', async () => {
    const mockServer = createMockServer()
    let editAttempts = 0

    const flakyFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'edit') {
        editAttempts++
        if (editAttempts <= 2) {
          throw new TypeError('fetch failed')
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: flakyFetch },
    })

    const login = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(login.result).to.equal('Success')

    const { data } = await api.postWithToken(
      'csrf',
      { action: 'edit', title: 'RetryPage', text: 'ok' },
      { retry: 3, retryDelay: 0 }
    )
    expect(editAttempts).to.equal(3)
    expect(data.edit.result).to.equal('Success')
  })

  it('postWithToken retries on fetch failed during token fetch', async () => {
    const mockServer = createMockServer()
    let tokenFetches = 0

    const flakyFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('meta=tokens') && !url.includes('type=login')) {
        tokenFetches++
        if (tokenFetches === 1) {
          throw new TypeError('fetch failed')
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: flakyFetch },
    })

    const login = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(login.result).to.equal('Success')

    const { data } = await api.postWithToken(
      'csrf',
      { action: 'edit', title: 'RetryTokenPage', text: 'ok' },
      { retry: 3, retryDelay: 0 }
    )
    expect(tokenFetches).to.equal(2)
    expect(data.edit.result).to.equal('Success')
  })

  it('postWithToken retries on HTTP 502 and throws HTTP_ERROR when exhausted', async () => {
    const mockServer = createMockServer()
    let editAttempts = 0

    const badGatewayFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'edit') {
        editAttempts++
        return new Response('Bad Gateway', {
          status: 502,
          statusText: 'Bad Gateway',
        })
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: badGatewayFetch },
    })
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    await expect(
      api.postWithToken(
        'csrf',
        { action: 'edit', title: 'FailPage', text: 'nope' },
        { retry: 3, retryDelay: 0 }
      )
    ).rejects.toMatchObject({
      name: 'WikiSaikouError',
      code: WikiSaikouErrorCode.HTTP_ERROR,
    })
    expect(editAttempts).to.equal(3)
  })

  it('postWithToken does not retry MediaWikiApiError or HTTP 400', async () => {
    const mockServer = createMockServer()
    let attempts = 0

    const errorFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'testError') {
        attempts++
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: errorFetch },
      throwOnApiError: true,
    })
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    await expect(
      api.postWithToken(
        'csrf',
        { action: 'testError' },
        { retry: 5, retryDelay: 0 }
      )
    ).rejects.toBeInstanceOf(MediaWikiApiError)
    expect(attempts).to.equal(1)

    let badReqAttempts = 0
    const badReqFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'edit') {
        badReqAttempts++
        return new Response(JSON.stringify({ message: 'Bad Request' }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'content-type': 'application/json' },
        })
      }
      return mockServer.mockFetch(input as any, init)
    }
    const api2 = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: badReqFetch },
    })
    await api2.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    await expect(
      api2.postWithToken(
        'csrf',
        { action: 'edit', title: 'BadReq', text: 'x' },
        { retry: 5, retryDelay: 0 }
      )
    ).rejects.toBeInstanceOf(WikiSaikouError)
    expect(badReqAttempts).to.equal(1)
  })

  it('get and post support retry option on transient fetch failed', async () => {
    const mockServer = createMockServer()
    let getAttempts = 0
    let postAttempts = 0

    const flakyFetch: typeof fetch = async (input, init) => {
      const method = getMethodFromFetchArgs(input, init)
      if (method === 'GET') {
        getAttempts++
        if (getAttempts < 3) {
          throw new TypeError('fetch failed')
        }
      } else if (method === 'POST') {
        postAttempts++
        if (postAttempts < 2) {
          throw new TypeError('fetch failed')
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: flakyFetch },
    })

    const getRes = await api.get(
      { action: 'query', meta: 'siteinfo' },
      { retry: 3, retryDelay: 0 }
    )
    expect(getAttempts).to.equal(3)
    expect(getRes.data.query.general).to.be.an('object')

    const postRes = await api.post(
      { action: 'parse', title: 'Retry', text: 'hi' },
      { retry: 2, retryDelay: 0 }
    )
    expect(postAttempts).to.equal(2)
    expect(postRes.data.parse.title).to.equal('Retry')
  })
})
