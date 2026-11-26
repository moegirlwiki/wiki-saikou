import { describe, expect, it } from 'vitest'
import {
  CookieJar,
  MediaWikiApi,
  MediaWikiApiError,
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
    if (input.method.toUpperCase() === 'POST') {
      const fd = await input.clone().formData()
      return fd.get('action') as string | null
    }
    return new URL(input.url).searchParams.get('action')
  }
  const url = typeof input === 'string' ? input : input.toString()
  if (init?.body instanceof FormData) {
    return init.body.get('action') as string | null
  }
  return new URL(url).searchParams.get('action')
}

describe('Cookie-based login (Node)', () => {
  it('reuses cookies from JSON string, array, CookieJar (including self), and raw Cookie header without action=login', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)

    const serializedJson = JSON.stringify(seedApi.cookieJar)
    const serializedArray = seedApi.cookieJar.toJSON()
    const rawHeader = seedApi.cookieJar.getCookieHeader(
      MOCK_API_ENDPOINT_URL.hostname,
      MOCK_API_ENDPOINT_URL.pathname
    )
    const prefixedHeader = `Cookie: ${rawHeader}`

    for (const cookieInput of [
      serializedJson,
      serializedArray,
      CookieJar.fromJSON(serializedArray),
      rawHeader,
      prefixedHeader,
    ]) {
      let loginPosts = 0
      let userinfoCalls = 0
      const spyFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        const action = await getActionFromFetchArgs(input, init)
        if (action === 'login') loginPosts++
        if (url.includes('meta=userinfo')) userinfoCalls++
        return server.mockFetch(input as any, init)
      }

      const api = new MediaWikiApi({
        baseURL: MOCK_API_ENDPOINT_URL.href,
        fexiosConfigs: { fetch: spyFetch },
      })
      const res = await api.login({ cookies: cookieInput })
      expect(res.result).to.equal('Success')
      expect(res.lgusername).to.equal(MOCK_MW_USERNAME)
      expect(res.lguserid).to.equal(1)
      expect(loginPosts).to.equal(0)
      expect(userinfoCalls).to.equal(1)

      // Subsequent requests should carry assertuser=<lgusername>
      let sawAssertUser = false
      const assertFetch: typeof fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        if (url.includes(`assertuser=${MOCK_MW_USERNAME}`)) {
          sawAssertUser = true
        }
        return server.mockFetch(input as any, init)
      }
      api.config.fexiosConfigs.fetch = assertFetch
      const site = await api.get({ action: 'query', meta: 'siteinfo' })
      expect(site.data.query.general).to.be.an('object')
      expect(sawAssertUser).to.equal(true)
    }

    // Passing the instance's own cookieJar should not lose cookies
    const selfRes = await seedApi.login({ cookies: seedApi.cookieJar })
    expect(selfRes.result).to.equal('Success')
    expect(selfRes.lgusername).to.equal(MOCK_MW_USERNAME)
  })

  it('throws LOGIN_FAILED and notifies onCookiesChange when expired cookies are cleared', async () => {
    const server = createMockServer()
    const snapshots: number[] = []
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
      onCookiesChange: (jar) => snapshots.push(jar.toJSON().length),
    })

    await expect(
      api.login({ cookies: 'wiki_session=expired_or_unknown' })
    ).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
    expect(api.cookieJar.toJSON()).to.have.length(0)
    expect(snapshots).to.deep.equal([0])
  })

  it('enforces assertuser on verify and fallback credential login, and falls back on expired cookie', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const validCookies = JSON.stringify(seedApi.cookieJar)

    // Mismatch without credentials -> throws LOGIN_FAILED and clears wrong-user cookies
    const mismatchOnly = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await expect(
      mismatchOnly.login({ cookies: validCookies, assertuser: 'OtherUser' })
    ).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
    expect(mismatchOnly.cookieJar.toJSON()).to.have.length(0)

    // Mismatch on fallback credentials too -> rejects instead of silently switching accounts
    const mismatchFallback = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await expect(
      mismatchFallback.login({
        cookies: 'wiki_session=expired',
        lgname: MOCK_MW_USERNAME,
        lgpassword: MOCK_MW_PASSWORD,
        assertuser: 'OtherUser',
      })
    ).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
    expect(mismatchFallback.cookieJar.toJSON()).to.have.length(0)

    // Expired cookie WITH matching credentials -> falls back to action=login and arms autoRelogin
    let loginPosts = 0
    const spyFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') loginPosts++
      return server.mockFetch(input as any, init)
    }
    const fallbackApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: spyFetch },
    })
    const res = await fallbackApi.login({
      cookies: 'wiki_session=expired',
      lgname: MOCK_MW_USERNAME,
      lgpassword: MOCK_MW_PASSWORD,
      assertuser: MOCK_MW_USERNAME,
    })
    expect(res.result).to.equal('Success')
    expect(res.lgusername).to.equal(MOCK_MW_USERNAME)
    expect(loginPosts).to.equal(1)

    // Drop session and verify autoRelogin works after fallback
    await fallbackApi.post({ action: 'testDropLogin' })
    const afterDrop = await fallbackApi.get({
      action: 'query',
      meta: 'userinfo',
    })
    expect(afterDrop.data.query.userinfo.name).to.equal(MOCK_MW_USERNAME)
    expect(loginPosts).to.equal(2)
  })

  it('supports legacy 4-arg login(lgname, lgpassword, params, { cookies }) with reuse and autoRelogin', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const saved = seedApi.cookieJar.toJSON()

    let loginPosts = 0
    const spyFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') loginPosts++
      return server.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: spyFetch },
    })
    const res = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD, undefined, {
      cookies: saved,
      assertuser: MOCK_MW_USERNAME,
    })
    expect(res.result).to.equal('Success')
    expect(res.lgusername).to.equal(MOCK_MW_USERNAME)
    expect(loginPosts).to.equal(0)

    // Session drops later -> autoRelogin kicks in using stored credentials
    await api.post({ action: 'testDropLogin' })
    const info = await api.get({ action: 'query', meta: 'userinfo' })
    expect(info.data.query.userinfo.name).to.equal(MOCK_MW_USERNAME)
    expect(loginPosts).to.equal(1)
  })

  it('falls back on private-wiki readapidenied, but propagates transient API errors like maxlag without clearing valid cookies', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const validCookies = seedApi.cookieJar.toJSON()

    // 1. readapidenied with throwOnApiError: true -> falls back to credentials
    let loginPosts = 0
    let denyUserinfo = true
    const privateWikiFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') {
        loginPosts++
        denyUserinfo = false
      }
      if (denyUserinfo && url.includes('meta=userinfo')) {
        return new Response(
          JSON.stringify({
            errors: [
              {
                code: 'readapidenied',
                text: 'You need read permission to use this module.',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return server.mockFetch(input as any, init)
    }

    const privateApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      throwOnApiError: true,
      fexiosConfigs: { fetch: privateWikiFetch },
    })
    const res = await privateApi.login({
      cookies: 'wiki_session=dead',
      lgname: MOCK_MW_USERNAME,
      lgpassword: MOCK_MW_PASSWORD,
    })
    expect(res.result).to.equal('Success')
    expect(loginPosts).to.equal(1)

    // 2. Transient maxlag during verify -> propagates MediaWikiApiError without clearing cookies or running action=login
    let maxlagLoginPosts = 0
    const maxlagFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'login') maxlagLoginPosts++
      if (url.includes('meta=userinfo')) {
        return new Response(
          JSON.stringify({
            errors: [{ code: 'maxlag', text: 'Waiting for replication lag' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return server.mockFetch(input as any, init)
    }

    const maxlagApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: maxlagFetch },
    })
    await expect(
      maxlagApi.login({
        cookies: validCookies,
        lgname: MOCK_MW_USERNAME,
        lgpassword: MOCK_MW_PASSWORD,
      })
    ).rejects.toSatisfy(
      (err: unknown) => MediaWikiApiError.is(err) && err.code === 'maxlag'
    )
    expect(maxlagLoginPosts).to.equal(0)
    expect(maxlagApi.cookieJar.toJSON()).to.have.length(1)
  })

  it('supports verify: false with 0 startup requests, assert=user / assertuser, and autoRelogin on first failure', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const saved = seedApi.cookieJar.toJSON()

    // 1. verify: false with assertuser -> 0 requests, attaches assertuser
    let fetchCount = 0
    let lastUrl = ''
    const spyFetch: typeof fetch = async (input, init) => {
      fetchCount++
      lastUrl = typeof input === 'string' ? input : (input as Request).url
      return server.mockFetch(input as any, init)
    }
    const apiWithName = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: spyFetch },
    })
    const res1 = await apiWithName.login({
      cookies: saved,
      verify: false,
      assertuser: MOCK_MW_USERNAME,
    })
    expect(fetchCount).to.equal(0)
    expect(res1).to.deep.equal({
      result: 'Success',
      lguserid: 0,
      lgusername: MOCK_MW_USERNAME,
    })
    await apiWithName.get({ action: 'query', meta: 'siteinfo' })
    expect(lastUrl).to.include(`assertuser=${MOCK_MW_USERNAME}`)

    // 2. verify: false WITHOUT assertuser -> attaches assert=user; fails with assertuserfailed if dropped
    let assertUserQuerySeen = false
    const apiNoName = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          if (url.includes('assert=user')) assertUserQuerySeen = true
          return server.mockFetch(input as any, init)
        },
      },
    })
    const res2 = await apiNoName.login({
      cookies: 'wiki_session=dead',
      verify: false,
    })
    expect(res2).to.deep.equal({ result: 'Success', lguserid: 0, lgusername: '' })
    const failedRes = await apiNoName.get({ action: 'query', meta: 'siteinfo' })
    expect(assertUserQuerySeen).to.equal(true)
    expect(failedRes.data.error?.code).to.equal('assertuserfailed')

    // 3. verify: false + credentials + expired cookie -> autoRelogin on assertuserfailed & upgrades to assertuser
    let loginPosts = 0
    const seenUrls: string[] = []
    const apiRelogin = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          const action = await getActionFromFetchArgs(input, init)
          if (action === 'login') loginPosts++
          seenUrls.push(url)
          return server.mockFetch(input as any, init)
        },
      },
    })
    await apiRelogin.login({
      cookies: 'wiki_session=expired',
      lgname: MOCK_MW_USERNAME,
      lgpassword: MOCK_MW_PASSWORD,
      verify: false,
    })
    expect(seenUrls).to.have.length(0)

    const siteRes = await apiRelogin.get({ action: 'query', meta: 'siteinfo' })
    expect(siteRes.data.query.general).to.be.an('object')
    expect(loginPosts).to.equal(1)

    // Next request should now use upgraded assertuser=<MOCK_MW_USERNAME>
    seenUrls.length = 0
    await apiRelogin.get({ action: 'query', meta: 'siteinfo' })
    expect(seenUrls[0]).to.include(`assertuser=${MOCK_MW_USERNAME}`)
  })

  it('rejects malformed cookies without destroying an existing session, and validates invalid option combinations', async () => {
    const server = createMockServer()
    let sawAssert = false
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          if (url.includes('assert=') || url.includes('assertuser=')) {
            sawAssert = true
          }
          return server.mockFetch(input as any, init)
        },
      },
    })

    // Establish an active session first
    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const activeCookies = api.cookieJar.toJSON()

    // Malformed serialized JSON must throw without clearing the active session
    await expect(api.login({ cookies: '[invalid-json' })).rejects.toThrow()
    expect(api.cookieJar.toJSON()).to.deep.equal(activeCookies)

    // Compile-time + runtime rejection of invalid option combinations
    // @ts-expect-error neither cookies nor credentials provided
    await expect(api.login({})).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
    // @ts-expect-error lgname without lgpassword
    await expect(api.login({ lgname: MOCK_MW_USERNAME })).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })

    // Type-level checks for mismatched option pairings (never executed)
    if (false as boolean) {
      // @ts-expect-error assertuser is only valid when cookies is provided
      void api.login({
        lgname: MOCK_MW_USERNAME,
        lgpassword: MOCK_MW_PASSWORD,
        assertuser: MOCK_MW_USERNAME,
      })
      // @ts-expect-error verify is only valid when cookies is provided
      void api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD, undefined, {
        verify: false,
      })
      // @ts-expect-error autoReloginRetries requires lgname + lgpassword
      void api.login({ cookies: 'wiki_session=x', autoReloginRetries: 2 })
    }

    sawAssert = false
    await api.login({
      cookies: 'wiki_session=anything',
      verify: false,
      autoRelogin: false,
    })
    await api.get({ action: 'query', meta: 'siteinfo' })
    expect(sawAssert).to.equal(false)
  })

  it('invokes onCookiesChange on Set-Cookie responses and logout()', async () => {
    const server = createMockServer()
    const snapshots: number[] = []
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
      onCookiesChange: (jar) => {
        snapshots.push(jar.toJSON().length)
      },
    })

    await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    // lgtoken + login both set wiki_session
    expect(snapshots.length).to.be.greaterThan(0)
    expect(snapshots[snapshots.length - 1]).to.equal(1)

    const countBeforeLogout = snapshots.length
    await api.logout()
    expect(snapshots.length).to.equal(countBeforeLogout + 1)
    expect(snapshots[snapshots.length - 1]).to.equal(0)

    // Second logout on already-empty jar should not fire redundantly
    const countAfterLogout = snapshots.length
    await api.logout()
    expect(snapshots.length).to.equal(countAfterLogout)
  })

  it('isolates in-flight cookie verify and logout() from concurrent session transitions', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const saved = seedApi.cookieJar.toJSON()

    // 1. logout() while verifyCookieSession is in flight
    let markVerifyStarted!: () => void
    const verifyStarted = new Promise<void>((r) => {
      markVerifyStarted = r
    })
    let releaseVerify!: () => void
    const verifyGate = new Promise<void>((r) => {
      releaseVerify = r
    })
    const gatedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('meta=userinfo')) {
        markVerifyStarted()
        await verifyGate
      }
      return server.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: gatedFetch },
    })
    const loginPromise = api.login({ cookies: saved })
    await verifyStarted
    await api.logout()
    releaseVerify()

    await expect(loginPromise).rejects.toThrow('Stale session epoch')
    expect(api.cookieJar.toJSON()).to.have.length(0)

    // 2. Newer login() completing while an earlier logout() is still awaiting server logout must not be wiped
    let markLogoutStarted!: () => void
    const logoutStarted = new Promise<void>((r) => {
      markLogoutStarted = r
    })
    let releaseLogout!: () => void
    const logoutGate = new Promise<void>((r) => {
      releaseLogout = r
    })
    const logoutRaceFetch: typeof fetch = async (input, init) => {
      const action = await getActionFromFetchArgs(input, init)
      if (action === 'logout') {
        markLogoutStarted()
        await logoutGate
      }
      return server.mockFetch(input as any, init)
    }

    const api2 = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: logoutRaceFetch },
    })
    await api2.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const logoutP = api2.logout()
    await logoutStarted
    const reloginRes = await api2.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    expect(reloginRes.result).to.equal('Success')
    const newerCookies = api2.cookieJar.toJSON()
    expect(newerCookies).to.have.length(1)
    releaseLogout()
    await logoutP
    expect(api2.cookieJar.toJSON()).to.deep.equal(newerCookies)
  })
})
