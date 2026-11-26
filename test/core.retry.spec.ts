import { describe, expect, it, vi } from 'vitest'
import {
  MediaWikiApi,
  MediaWikiApiError,
  MediaWikiRestApi,
  WikiSaikouErrorCode,
  createRetryDelay,
  isRetryableTransportError,
  parseRetryAfterMs,
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

describe('MediaWikiApi retry & cancellation', () => {
  it('does not retry transport errors by default and preserves original error', async () => {
    const mockServer = createMockServer()
    let getAttempts = 0
    let postAttempts = 0

    const flakyFetch: typeof fetch = async (input, init) => {
      const method = getMethodFromFetchArgs(input, init)
      if (method === 'GET' && !(typeof input === 'string' ? input : (input as Request).url).includes('meta=tokens')) {
        getAttempts++
        throw new TypeError('fetch failed')
      }
      if (method === 'POST') {
        const action = await getActionFromFetchArgs(input, init)
        if (action === 'edit') {
          postAttempts++
          throw new TypeError('fetch failed')
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: flakyFetch },
    })

    // Default get() does not retry transport error and throws FexiosError directly
    await expect(
      api.get({ action: 'query', meta: 'siteinfo' })
    ).rejects.toMatchObject({ name: 'FexiosError', code: 'NETWORK_ERROR' })
    expect(getAttempts).to.equal(1)

    // Default postWithToken() does not retry transport error and preserves original FexiosError (not HTTP_ERROR)
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    await expect(
      api.postWithToken('csrf', { action: 'edit', title: 'P', text: 'x' })
    ).rejects.toMatchObject({ name: 'FexiosError', code: 'NETWORK_ERROR' })
    expect(postAttempts).to.equal(1)
  })

  it('retries transport errors when caller opts in via shouldRetry', async () => {
    const mockServer = createMockServer()
    let getAttempts = 0
    let editAttempts = 0

    const flakyFetch: typeof fetch = async (input, init) => {
      const method = getMethodFromFetchArgs(input, init)
      if (method === 'GET') {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes('meta=siteinfo')) {
          getAttempts++
          if (getAttempts < 3) {
            throw new TypeError('fetch failed')
          }
        }
      } else if (method === 'POST') {
        const action = await getActionFromFetchArgs(input, init)
        if (action === 'edit') {
          editAttempts++
          if (editAttempts < 3) {
            return new Response('Bad Gateway', { status: 502 })
          }
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: flakyFetch },
      shouldRetry: isRetryableTransportError,
      retryDelay: 0,
    })

    const siteRes = await api.get(
      { action: 'query', meta: 'siteinfo' },
      { retry: 3 }
    )
    expect(getAttempts).to.equal(3)
    expect(siteRes.data.query.general).to.be.an('object')

    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const editRes = await api.postWithToken(
      'csrf',
      { action: 'edit', title: 'RetryPage', text: 'ok' },
      { retry: 3 }
    )
    expect(editAttempts).to.equal(3)
    expect(editRes.data.edit.result).to.equal('Success')
  })

  it('preserves MediaWikiApiError response headers and actually waits for Retry-After', async () => {
    vi.useFakeTimers()
    try {
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
              {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'retry-after': '5',
                },
              }
            )
          }
        }
        return mockServer.mockFetch(input as any, init)
      }

      const delays: number[] = []
      const delayHelper = createRetryDelay()
      const api = new MediaWikiApi({
        baseURL: MOCK_API_ENDPOINT_URL.href,
        fexiosConfigs: { fetch: maxlagFetch },
        throwOnApiError: true,
        retry: 3,
        shouldRetry: (err) =>
          MediaWikiApiError.is(err) &&
          err.errors.some((e) => e.code === 'maxlag'),
        retryDelay: (err, count) => {
          const ms = delayHelper(err, count)
          delays.push(ms)
          return ms
        },
      })
      await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

      let settled = false
      const promise = api
        .postWithToken('csrf', { action: 'edit', title: 'Maxlag', text: 'ok' })
        .then((res) => {
          settled = true
          return res
        })

      // Attempt 1 fails -> waiting 5000ms for Retry-After
      await vi.advanceTimersByTimeAsync(4999)
      expect(maxlagAttempts).to.equal(1)
      expect(settled).to.equal(false)

      await vi.advanceTimersByTimeAsync(1)
      // Attempt 2 runs and fails -> waiting another 5000ms
      await vi.advanceTimersByTimeAsync(4999)
      expect(maxlagAttempts).to.equal(2)
      expect(settled).to.equal(false)

      await vi.advanceTimersByTimeAsync(1)
      const res = await promise
      expect(settled).to.equal(true)
      expect(maxlagAttempts).to.equal(3)
      expect(delays).to.deep.equal([5000, 5000])
      expect(res.data.edit.result).to.equal('Success')
    } finally {
      vi.useRealTimers()
    }
  })

  it('invokes onRetry only when another attempt will actually run', async () => {
    const mockServer = createMockServer()
    let attempts = 0
    const onRetryCalls: number[] = []

    const failFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('meta=siteinfo')) {
        attempts++
        throw new TypeError('fetch failed')
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: failFetch },
    })

    await expect(
      api.get(
        { action: 'query', meta: 'siteinfo' },
        {
          retry: 2,
          retryDelay: 0,
          shouldRetry: isRetryableTransportError,
          onRetry: (_err, count) => onRetryCalls.push(count),
        }
      )
    ).rejects.toMatchObject({ name: 'FexiosError' })

    expect(attempts).to.equal(2)
    expect(onRetryCalls).to.deep.equal([0])
  })

  it('deduplicates concurrent getToken (including forced refresh) and reloginIfNeeded', async () => {
    const mockServer = createMockServer()
    let tokenFetches = 0
    let loginPosts = 0

    const countingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (url.includes('meta=tokens') && !url.includes('type=login')) {
        tokenFetches++
      }
      if (action === 'login') {
        loginPosts++
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: countingFetch },
    })
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    // Concurrent forced refreshes share one request
    const [t1, t2, t3] = await Promise.all([
      api.getToken('csrf', true),
      api.getToken('csrf', true),
      api.getToken('csrf', true),
    ])
    expect(t1).to.equal(t2)
    expect(t2).to.equal(t3)
    expect(tokenFetches).to.equal(1)

    // Concurrent assertuserfailed responses share one relogin
    let siteinfoCalls = 0
    const reloginFetch: typeof fetch = async (input, init) => {
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
      fexiosConfigs: { fetch: reloginFetch },
    })
    loginPosts = 0
    await api2.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(loginPosts).to.equal(1)

    await Promise.all([
      api2.get({ action: 'query', meta: 'siteinfo' }),
      api2.get({ action: 'query', meta: 'siteinfo' }),
      api2.get({ action: 'query', meta: 'siteinfo' }),
    ])
    expect(loginPosts).to.equal(2)
  })

  it('cancels in-flight request and pending backoff sleep via AbortSignal without cancelling other token waiters', async () => {
    const mockServer = createMockServer()

    // 1. In-flight request cancellation (even with retry: 1)
    const inFlightController = new AbortController()
    let capturedSignalAborted = false
    let markFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const hangingFetch: typeof fetch = (input, init) => {
      const reqSignal =
        input instanceof Request ? input.signal : init?.signal ?? undefined
      if (reqSignal?.aborted) {
        capturedSignalAborted = true
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      markFetchStarted()
      return new Promise((_resolve, reject) => {
        reqSignal?.addEventListener('abort', () => {
          capturedSignalAborted = true
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }
    const api1 = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: hangingFetch },
    })
    const p1 = api1.get(
      { action: 'query', meta: 'siteinfo' },
      { signal: inFlightController.signal }
    )
    await fetchStarted
    inFlightController.abort()
    await expect(p1).rejects.toMatchObject({ name: 'FexiosError' })
    expect(capturedSignalAborted).to.equal(true)

    // 2. Abort during pending backoff sleep
    vi.useFakeTimers()
    try {
      const sleepController = new AbortController()
      let sleepAttempts = 0
      const failFetch: typeof fetch = async () => {
        sleepAttempts++
        throw new TypeError('fetch failed')
      }
      const api2 = new MediaWikiApi({
        baseURL: MOCK_API_ENDPOINT_URL.href,
        fexiosConfigs: { fetch: failFetch },
      })
      const p2 = api2.get(
        { action: 'query', meta: 'siteinfo' },
        {
          retry: 5,
          retryDelay: 5000,
          shouldRetry: isRetryableTransportError,
          signal: sleepController.signal,
        }
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(sleepAttempts).to.equal(1)
      sleepController.abort()
      await expect(p2).rejects.toMatchObject({ name: 'AbortError' })
      expect(sleepAttempts).to.equal(1)
    } finally {
      vi.useRealTimers()
    }

    // 3. One caller aborting getToken does not reject another concurrent caller
    const cA = new AbortController()
    const cB = new AbortController()
    const delayedTokenFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('meta=tokens')) {
        await new Promise((r) => setTimeout(r, 20))
      }
      return mockServer.mockFetch(input as any, init)
    }
    const api3 = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: delayedTokenFetch },
    })
    const reqA = api3.getToken('csrf', false, { signal: cA.signal })
    const reqB = api3.getToken('csrf', false, { signal: cB.signal })
    cA.abort()
    await expect(reqA).rejects.toMatchObject({ name: 'AbortError' })
    await expect(reqB).resolves.to.be.a('string')
  })

  it('supports FormData in postWithToken, MediaWikiRestApi retry callback, explicit retry: 1, and non-finite validation', async () => {
    const mockServer = createMockServer()
    let editAttempts = 0

    const formFetch: typeof fetch = async (input, init) => {
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
      fexiosConfigs: { fetch: formFetch },
      retry: 3,
      retryDelay: 0,
      shouldRetry: isRetryableTransportError,
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

    // MediaWikiRestApi with shouldRetry callback
    let restAttempts = 0
    const restFetch: typeof fetch = async (input, init) => {
      restAttempts++
      if (restAttempts < 3) {
        throw new TypeError('fetch failed')
      }
      return mockServer.mockFetch(input as any, init)
    }
    const rest = new MediaWikiRestApi({
      baseURL: 'https://wiki-saikou.test/rest.php/',
      fexiosConfigs: { fetch: restFetch },
      retry: 3,
      retryDelay: 0,
      shouldRetry: isRetryableTransportError,
    })
    const restRes = await rest.get('/v1/page/{title}', {
      pathParams: { title: 'Main_Page' },
    })
    expect(restAttempts).to.equal(3)
    expect(restRes.data.ok).to.equal(true)

    // Explicit retry: 1 disables postWithToken badtoken retries
    const noRetryApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: mockServer.mockFetch },
      retry: 1,
    })
    mockServer.enableBadtokenTestMode()
    try {
      await noRetryApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
      await expect(
        noRetryApi.postWithToken('csrf', { action: 'testBadtoken' })
      ).rejects.toMatchObject({
        code: WikiSaikouErrorCode.TOKEN_RETRY_LIMIT_EXCEEDED,
      })
    } finally {
      mockServer.disableBadtokenTestMode()
    }

    // Non-finite / non-integer retry validation
    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: Infinity })
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: 1.5 })
    ).rejects.toBeInstanceOf(RangeError)

    // badtoken passes Error to retryDelay
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

    expect(
      parseRetryAfterMs({ response: { headers: new Headers({ 'Retry-After': '2' }) } })
    ).to.equal(2000)
  })
})
