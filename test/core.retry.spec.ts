import { describe, expect, it } from 'vitest'
import {
  MediaWikiApi,
  MediaWikiApiError,
  MediaWikiRestApi,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from '@/node.js'
import { parseRetryAfterMs } from '../src/utils/useRetry.js'
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

  it('deduplicates concurrent getToken and reloginIfNeeded requests', async () => {
    const mockServer = createMockServer()
    let tokenFetches = 0
    let loginPosts = 0
    let assertFailActive = false

    const countingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (url.includes('meta=tokens') && !url.includes('type=login')) {
        tokenFetches++
      }
      if (action === 'login') {
        loginPosts++
      }
      if (assertFailActive && getMethodFromFetchArgs(input, init) === 'GET' && url.includes('meta=siteinfo')) {
        assertFailActive = false
        return new Response(
          JSON.stringify({
            errors: [{ code: 'assertuserfailed', text: 'Assertion failed' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: countingFetch },
    })

    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(loginPosts).to.equal(1)

    const [t1, t2, t3] = await Promise.all([
      api.getToken('csrf'),
      api.getToken('csrf'),
      api.getToken('csrf'),
    ])
    expect(t1).to.equal(t2)
    expect(t2).to.equal(t3)
    expect(tokenFetches).to.equal(1)

    // Trigger concurrent assertuserfailed responses
    let siteinfoCalls = 0
    const concurrentFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') {
        loginPosts++
      }
      if (url.includes('meta=siteinfo')) {
        siteinfoCalls++
        if (siteinfoCalls <= 3) {
          return new Response(
            JSON.stringify({
              errors: [{ code: 'assertuserfailed', text: 'Assertion failed' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api2 = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: concurrentFetch },
    })
    loginPosts = 0
    await api2.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(loginPosts).to.equal(1)

    await Promise.all([
      api2.get({ action: 'query', meta: 'siteinfo' }),
      api2.get({ action: 'query', meta: 'siteinfo' }),
      api2.get({ action: 'query', meta: 'siteinfo' }),
    ])
    // Only 1 extra login for all 3 concurrent assertuserfailed responses
    expect(loginPosts).to.equal(2)
  })

  it('retries maxlag/ratelimited errors and parses Retry-After header', async () => {
    const mockServer = createMockServer()
    let maxlagAttempts = 0

    const maxlagFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'edit') {
        maxlagAttempts++
        if (maxlagAttempts < 3) {
          return new Response(
            JSON.stringify({
              errors: [{ code: 'maxlag', text: 'Waiting for replication lag' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: maxlagFetch },
      throwOnApiError: true,
      retry: 3,
      retryDelay: 0,
    })
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    const { data } = await api.postWithToken('csrf', {
      action: 'edit',
      title: 'MaxlagPage',
      text: 'ok',
    })
    expect(maxlagAttempts).to.equal(3)
    expect(data.edit.result).to.equal('Success')

    const errWithHeader = {
      response: { headers: new Headers({ 'Retry-After': '2' }) },
    }
    expect(parseRetryAfterMs(errWithHeader)).to.equal(2000)
  })

  it('postWithToken supports FormData body and MediaWikiRestApi supports retry', async () => {
    const mockServer = createMockServer()
    let editAttempts = 0

    const formDataFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'edit') {
        editAttempts++
        if (editAttempts === 1) {
          throw new TypeError('fetch failed')
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: formDataFetch },
      retry: 3,
      retryDelay: 0,
    })
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    const form = new FormData()
    form.set('action', 'edit')
    form.set('title', 'FormDataPage')
    form.set('text', 'hello')

    const { data } = await api.postWithToken('csrf', form)
    expect(editAttempts).to.equal(2)
    expect(data.edit.result).to.equal('Success')
    expect(form.has('token')).to.equal(false)

    let restAttempts = 0
    const restFlakyFetch: typeof fetch = async (input, init) => {
      restAttempts++
      if (restAttempts < 3) {
        throw new TypeError('fetch failed')
      }
      return mockServer.mockFetch(input as any, init)
    }
    const rest = new MediaWikiRestApi({
      baseURL: 'https://wiki-saikou.test/rest.php/',
      fexiosConfigs: { fetch: restFlakyFetch },
      retry: 3,
      retryDelay: 0,
    })
    const restRes = await rest.get('/v1/page/{title}', {
      pathParams: { title: 'Main_Page' },
    })
    expect(restAttempts).to.equal(3)
    expect(restRes.data.ok).to.equal(true)
  })

  it('rejects non-finite retry, skips non-network TypeError, and passes Error to retryDelay on badtoken', async () => {
    const mockServer = createMockServer()
    let nonNetworkAttempts = 0

    const nonNetworkFetch: typeof fetch = async () => {
      nonNetworkAttempts++
      throw new TypeError('Cannot read properties of undefined')
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: nonNetworkFetch },
    })

    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: Infinity })
    ).rejects.toBeInstanceOf(RangeError)

    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: 3, retryDelay: 0 })
    ).rejects.toMatchObject({ name: 'FexiosError' })
    expect(nonNetworkAttempts).to.equal(1)

    const seenErrors: unknown[] = []
    const apiBadToken = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: mockServer.mockFetch },
    })
    mockServer.enableBadtokenTestMode()
    try {
      await apiBadToken.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
      await apiBadToken.postWithToken(
        'csrf',
        { action: 'testBadtoken' },
        {
          retry: 3,
          retryDelay: (err) => {
            seenErrors.push(err)
            return 0
          },
        }
      )
      expect(seenErrors).to.have.length(1)
      expect(seenErrors[0]).to.be.instanceOf(Error)
    } finally {
      mockServer.disableBadtokenTestMode()
    }
  })
})
