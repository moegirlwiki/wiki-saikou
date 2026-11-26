import { describe, expect, it } from 'vitest'
import {
  CookieJar,
  MediaWikiApi,
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

  it('throws LOGIN_FAILED for expired/invalid cookies when no credentials are provided', async () => {
    const server = createMockServer()
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })

    await expect(
      api.login({ cookies: 'wiki_session=expired_or_unknown' })
    ).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
  })

  it('checks expected username and falls back to credentials on mismatch or expired cookie', async () => {
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
      mismatchOnly.login({ cookies: validCookies, username: 'OtherUser' })
    ).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
    expect(mismatchOnly.cookieJar.toJSON()).to.have.length(0)

    // Expired cookie WITH credentials -> falls back to action=login and arms autoRelogin
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

  it('falls back to credentials on private-wiki readapidenied during verify (including throwOnApiError: true)', async () => {
    const server = createMockServer()
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

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      throwOnApiError: true,
      fexiosConfigs: { fetch: privateWikiFetch },
    })
    const res = await api.login({
      cookies: 'wiki_session=dead',
      lgname: MOCK_MW_USERNAME,
      lgpassword: MOCK_MW_PASSWORD,
    })
    expect(res.result).to.equal('Success')
    expect(loginPosts).to.equal(1)
  })

  it('supports verify: false with 0 startup requests, assert=user / assertuser, and autoRelogin on first failure', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const saved = seedApi.cookieJar.toJSON()

    // 1. verify: false with username -> 0 requests, attaches assertuser
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
      username: MOCK_MW_USERNAME,
    })
    expect(fetchCount).to.equal(0)
    expect(res1).to.deep.equal({
      result: 'Success',
      lguserid: 0,
      lgusername: MOCK_MW_USERNAME,
    })
    await apiWithName.get({ action: 'query', meta: 'siteinfo' })
    expect(lastUrl).to.include(`assertuser=${MOCK_MW_USERNAME}`)

    // 2. verify: false WITHOUT username -> attaches assert=user; fails with assertuserfailed if dropped
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

  it('respects autoRelogin: false and validates missing/partial login inputs', async () => {
    const server = createMockServer()
    let sawAssert = false
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          if (url.includes('assert=' ) || url.includes('assertuser=')) {
            sawAssert = true
          }
          return server.mockFetch(input as any, init)
        },
      },
    })

    await expect(api.login({})).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })
    await expect(api.login({ lgname: MOCK_MW_USERNAME })).rejects.toMatchObject({
      code: WikiSaikouErrorCode.LOGIN_FAILED,
    })

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

  it('isolates in-flight cookie verify from concurrent logout()', async () => {
    const server = createMockServer()
    const seedApi = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: server.mockFetch },
    })
    await seedApi.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
    const saved = seedApi.cookieJar.toJSON()

    let releaseVerify!: () => void
    const verifyGate = new Promise<void>((r) => {
      releaseVerify = r
    })
    const gatedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.includes('meta=userinfo')) {
        await verifyGate
      }
      return server.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: gatedFetch },
    })
    const loginPromise = api.login({ cookies: saved })
    await new Promise((r) => setTimeout(r, 20))
    await api.logout()
    releaseVerify()

    await expect(loginPromise).rejects.toThrow('Stale session epoch')
    expect(api.cookieJar.toJSON()).to.have.length(0)
  })
})
