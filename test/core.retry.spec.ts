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

    // Non-badtoken { ok: false } errors (e.g. business errors) are NOT retried unconditionally
    let okFalseAttempts = 0
    const okFalseApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: mockServer.mockFetch },
    })
    await okFalseApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    vi.spyOn(okFalseApi, 'post').mockImplementation(async () => {
      okFalseAttempts++
      throw Object.assign(new Error('abusefilter'), { ok: false })
    })
    await expect(
      okFalseApi.postWithToken('csrf', { action: 'edit', title: 'P', text: 'x' })
    ).rejects.toMatchObject({ message: 'abusefilter', ok: false })
    expect(okFalseAttempts).to.equal(1)
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

    // Non-finite / non-integer / < 1 retry validation
    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: Infinity })
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: 1.5 })
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      api.get({ action: 'query', meta: 'siteinfo' }, { retry: 0 })
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

  it('handles relogin/logout race, postWithToken cached-token signal, abort during relogin, linked abortController, and 429/400 classification', async () => {
    const mockServer = createMockServer()

    // 1. Late relogin response after logout() does not restore session or replay old request
    let releaseRelogin!: () => void
    const reloginGate = new Promise<void>((r) => {
      releaseRelogin = r
    })
    let loginCount = 0
    let siteinfoCount = 0
    const logoutRaceFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') {
        loginCount++
        if (loginCount === 2) {
          await reloginGate
        }
      }
      if (url.includes('meta=siteinfo')) {
        siteinfoCount++
        if (siteinfoCount === 1) {
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

    const apiLogoutRace = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: logoutRaceFetch },
    })
    await apiLogoutRace.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const pendingReq = apiLogoutRace.get({ action: 'query', meta: 'siteinfo' })
    await new Promise((r) => setTimeout(r, 20))
    await apiLogoutRace.logout()
    releaseRelogin()
    await pendingReq
    expect(siteinfoCount).to.equal(1)
    expect(apiLogoutRace.cookieJar.getCookies('wiki-saikou.test')).to.have.length(0)

    // 2. postWithToken with cached token + AbortSignal does not fail deepMerge
    const apiSig = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: mockServer.mockFetch },
    })
    await apiSig.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    await apiSig.getToken('csrf')
    const sigRes = await apiSig.postWithToken(
      'csrf',
      { action: 'edit', title: 'SigPage', text: 'ok' },
      { signal: new AbortController().signal }
    )
    expect(sigRes.data.edit.result).to.equal('Success')

    // 3. Aborting edit while relogin is in progress prevents replay
    let releaseEditRelogin!: () => void
    const editReloginGate = new Promise<void>((r) => {
      releaseEditRelogin = r
    })
    let editLoginCount = 0
    let editCalls = 0
    const abortReloginFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') {
        editLoginCount++
        if (editLoginCount === 2) {
          await editReloginGate
        }
      }
      if (action === 'edit') {
        editCalls++
        return new Response(
          JSON.stringify({
            errors: [{ code: 'assertuserfailed', text: 'Assertion failed' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return mockServer.mockFetch(input as any, init)
    }
    const apiAbortRelogin = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: abortReloginFetch },
    })
    await apiAbortRelogin.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const editController = new AbortController()
    const editPromise = apiAbortRelogin.post(
      { action: 'edit', title: 'AbortRelogin', text: 'x' },
      { signal: editController.signal }
    )
    await new Promise((r) => setTimeout(r, 20))
    editController.abort()
    await expect(editPromise).rejects.toMatchObject({ name: 'AbortError' })
    releaseEditRelogin()
    await new Promise((r) => setTimeout(r, 20))
    expect(editCalls).to.equal(1)

    // 4. Passing both signal and abortController still aborts via signal
    const linkedSignalController = new AbortController()
    const existingAbortController = new AbortController()
    let linkedAborted = false
    let markLinkedStarted!: () => void
    const linkedStarted = new Promise<void>((r) => {
      markLinkedStarted = r
    })
    const apiLinked = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: (input, init) => {
          const reqSignal =
            input instanceof Request ? input.signal : init?.signal ?? undefined
          markLinkedStarted()
          return new Promise((_res, rej) => {
            reqSignal?.addEventListener('abort', () => {
              linkedAborted = true
              rej(new DOMException('Aborted', 'AbortError'))
            })
          })
        },
      },
    })
    const linkedP = apiLinked.get(
      { action: 'query', meta: 'siteinfo' },
      {
        signal: linkedSignalController.signal,
        abortController: existingAbortController,
      }
    )
    await linkedStarted
    linkedSignalController.abort()
    await expect(linkedP).rejects.toMatchObject({ name: 'FexiosError' })
    expect(linkedAborted).to.equal(true)

    // 5. throwOnApiError=true: 429 with API error body retries; plain-text 400 does not retry
    let rate429Attempts = 0
    let bad400Attempts = 0
    const statusApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      throwOnApiError: true,
      shouldRetry: isRetryableTransportError,
      retryDelay: 0,
      fexiosConfigs: {
        fetch: async (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          if (url.includes('case=429')) {
            rate429Attempts++
            if (rate429Attempts === 1) {
              return new Response(
                JSON.stringify({
                  errors: [{ code: 'ratelimited', text: 'Too many requests' }],
                }),
                { status: 429, headers: { 'content-type': 'application/json' } }
              )
            }
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          bad400Attempts++
          return new Response('Bad Request', {
            status: 400,
            headers: { 'content-type': 'text/plain' },
          })
        },
      },
    })

    const res429 = await statusApi.get(
      { action: 'query', case: '429' },
      { retry: 2 }
    )
    expect(rate429Attempts).to.equal(2)
    expect(res429.data.ok).to.equal(true)

    await expect(
      statusApi.get({ action: 'query', case: '400' }, { retry: 3 })
    ).rejects.toMatchObject({ name: 'FexiosError', code: 'BODY_TRANSFORM_ERROR' })
    expect(bad400Attempts).to.equal(1)

    // 6. MediaWikiRestApi: plain-text 400 does not retry; HTML 502 retries; abortController stops retry loop
    let rest400Attempts = 0
    let rest502Attempts = 0
    const restStatusClient = new MediaWikiRestApi({
      baseURL: 'https://wiki-saikou.test/rest.php/',
      shouldRetry: isRetryableTransportError,
      retryDelay: 0,
      fexiosConfigs: {
        responseType: 'json',
        fetch: async (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          if (url.includes('400')) {
            rest400Attempts++
            return new Response('Bad Request', { status: 400 })
          }
          rest502Attempts++
          if (rest502Attempts === 1) {
            return new Response('Bad Gateway', { status: 502 })
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      },
    })
    await expect(
      restStatusClient.get('/v1/page/400', { retry: 3 })
    ).rejects.toMatchObject({ name: 'FexiosError', code: 'BODY_TRANSFORM_ERROR' })
    expect(rest400Attempts).to.equal(1)

    const rest502Res = await restStatusClient.get('/v1/page/502', { retry: 2 })
    expect(rest502Attempts).to.equal(2)
    expect(rest502Res.data.ok).to.equal(true)

    // abortController stops retry loop even if shouldRetry returns true (without invoking onRetry)
    const acOnly = new AbortController()
    let acAttempts = 0
    let acOnRetryCalls = 0
    const acApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: async () => {
          acAttempts++
          acOnly.abort()
          throw new TypeError('fetch failed')
        },
      },
    })
    await expect(
      acApi.get(
        { action: 'query', meta: 'siteinfo' },
        {
          retry: 5,
          retryDelay: 0,
          shouldRetry: () => true,
          onRetry: () => {
            acOnRetryCalls++
          },
          abortController: acOnly,
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(acAttempts).to.equal(1)
    expect(acOnRetryCalls).to.equal(0)

    // Retry-After: 0 and HTTP-date
    expect(
      parseRetryAfterMs({ response: { headers: new Headers({ 'Retry-After': '0' }) } })
    ).to.equal(0)
    const futureDate = new Date(Date.now() + 2000).toUTCString()
    const parsedDateMs = parseRetryAfterMs({
      response: { headers: new Headers({ 'Retry-After': futureDate }) },
    })
    expect(parsedDateMs).to.be.at.least(0).and.at.most(3000)

    // 7. Old relogin finishing AFTER logout() + new login() does NOT wipe new session cookies/tokens
    let releaseOldRelogin!: () => void
    const oldReloginGate = new Promise<void>((r) => {
      releaseOldRelogin = r
    })
    let seqLoginCount = 0
    let seqSiteinfoCount = 0
    const newSessionFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') {
        seqLoginCount++
        if (seqLoginCount === 2) {
          await oldReloginGate
        }
      }
      if (url.includes('meta=siteinfo')) {
        seqSiteinfoCount++
        if (seqSiteinfoCount === 1) {
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
    const apiNewSession = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: newSessionFetch },
    })
    await apiNewSession.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const oldReq = apiNewSession.get({ action: 'query', meta: 'siteinfo' })
    await new Promise((r) => setTimeout(r, 20))
    await apiNewSession.logout()
    await apiNewSession.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const newCsrf = await apiNewSession.getToken('csrf')
    const newCookies = apiNewSession.cookieJar.getCookies('wiki-saikou.test')
    expect(newCookies.length).to.be.greaterThan(0)
    releaseOldRelogin()
    await oldReq
    expect(apiNewSession.cookieJar.getCookies('wiki-saikou.test')).to.deep.equal(
      newCookies
    )
    expect(apiNewSession.tokens.get('csrf')).to.equal(newCsrf)

    // 8. baseConfigs.fetch is preserved (not bypassed to globalThis.fetch)
    let baseFetchUsed = 0
    const apiBaseFetch = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
    })
    apiBaseFetch.request.baseConfigs.fetch = async (input, init) => {
      baseFetchUsed++
      return mockServer.mockFetch(input as any, init)
    }
    await apiBaseFetch.get({ action: 'query', meta: 'siteinfo' })
    expect(baseFetchUsed).to.equal(1)

    let restBaseFetchUsed = 0
    const restBaseFetch = new MediaWikiRestApi({
      baseURL: 'https://wiki-saikou.test/rest.php/',
    })
    restBaseFetch.http.baseConfigs.fetch = async (input, init) => {
      restBaseFetchUsed++
      return mockServer.mockFetch(input as any, init)
    }
    await restBaseFetch.get('/v1/page/{title}', {
      pathParams: { title: 'Main_Page' },
    })
    expect(restBaseFetchUsed).to.equal(1)

    // 9. Frozen errors thrown in afterResponse are preserved without TypeError
    const frozenErr = Object.freeze(new Error('frozen afterResponse error'))
    const apiFrozen = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: mockServer.mockFetch },
    })
    apiFrozen.request.on('afterResponse', () => {
      throw frozenErr
    })
    await expect(
      apiFrozen.get({ action: 'query', meta: 'siteinfo' })
    ).rejects.toBe(frozenErr)

    // 10. Old login()'s token GET failure does NOT propagate to new login() after logout()
    let releaseOldLoginToken!: () => void
    const oldLoginTokenGate = new Promise<void>((r) => {
      releaseOldLoginToken = r
    })
    let loginTokenCalls = 0
    const tokenIsolationFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('meta=tokens') && url.includes('type=login')) {
        loginTokenCalls++
        if (loginTokenCalls === 1) {
          await oldLoginTokenGate
          throw new TypeError('fetch failed')
        }
      }
      return mockServer.mockFetch(input as any, init)
    }
    const apiTokenIso = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: tokenIsolationFetch },
    })
    const oldLoginP = apiTokenIso.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    await new Promise((r) => setTimeout(r, 20))
    await apiTokenIso.logout()
    const newLoginRes = await apiTokenIso.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(newLoginRes.result).to.equal('Success')
    expect(loginTokenCalls).to.equal(2)
    releaseOldLoginToken()
    await expect(oldLoginP).rejects.toMatchObject({
      name: 'FexiosError',
      code: 'NETWORK_ERROR',
    })

    // 11. Caller customEnv.sessionEpoch does not collide with internal session guard
    const customEnvRes = await apiTokenIso.get(
      { action: 'query', meta: 'siteinfo' },
      { customEnv: { sessionEpoch: 42 } }
    )
    expect(customEnvRes.data.query.general).to.be.an('object')
    expect(customEnvRes.runtime.customEnv?.sessionEpoch).to.equal(42)

    // 12. postWithToken propagates fexiosOptions.abortController.signal to getToken & retry loop
    let acTokenCalls = 0
    const acController = new AbortController()
    const acTokenFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const bodyStr = typeof init?.body === 'string' ? init.body : ''
      if (url.includes('type=csrf') || bodyStr.includes('type=csrf')) {
        acTokenCalls++
        acController.abort()
        throw new TypeError('network down')
      }
      return mockServer.mockFetch(input as any, init)
    }
    const apiAcToken = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: acTokenFetch },
    })
    await expect(
      apiAcToken.postWithToken(
        'csrf',
        { action: 'edit', title: 'AcToken', text: 'x' },
        {
          retry: 5,
          retryDelay: 0,
          shouldRetry: () => true,
          fexiosOptions: { abortController: acController },
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(acTokenCalls).to.equal(1)
  })
})
