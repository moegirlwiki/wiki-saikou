import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi, WikiSaikouError } from '@/node.js'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_USERNAME,
  MOCK_MW_PASSWORD,
  createMockServer,
} from './__mock__/mwApiServer.js'

describe('Tokens (badtoken auto refresh)', () => {
  it('auto refresh on badtoken', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: { 'api-user-agent': env.API_USER_AGENT || '' },
        fetch: mockServer.mockFetch,
      },
    })
    mockServer.enableBadtokenTestMode()
    try {
      const login = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
      expect(login.result).to.equal('Success')
      const initialToken = await api.getToken('csrf')
      const { data } = await api.postWithToken('csrf', {
        action: 'testBadtoken',
      })
      expect(data.success.result).to.equal('Success')
      const newToken = await api.getToken('csrf')
      expect(newToken).to.not.equal(initialToken)
    } finally {
      mockServer.disableBadtokenTestMode()
    }
  })

  it('auto refresh on badtoken when throwOnApiError=true', async () => {
    const mockServer = createMockServer()
    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: {
        headers: { 'api-user-agent': env.API_USER_AGENT || '' },
        fetch: mockServer.mockFetch,
      },
      throwOnApiError: true,
    })
    mockServer.enableBadtokenTestMode()
    try {
      const login = await api.login(MOCK_MW_USERNAME, MOCK_MW_PASSWORD)
      expect(login.result).to.equal('Success')
      const initialToken = await api.getToken('csrf')
      const { data } = await api.postWithToken('csrf', {
        action: 'testBadtoken',
      })
      expect(data.success.result).to.equal('Success')
      const newToken = await api.getToken('csrf')
      expect(newToken).to.not.equal(initialToken)
    } finally {
      mockServer.disableBadtokenTestMode()
    }
  })

  it('detects NeedToken and WrongToken in WikiSaikouError.isBadTokenError', () => {
    expect(
      WikiSaikouError.isBadTokenError({
        login: { result: 'NeedToken', token: 'abc+\\' },
      })
    ).to.equal(true)
    expect(
      WikiSaikouError.isBadTokenError({
        login: { result: 'WrongToken' },
      })
    ).to.equal(true)
    expect(
      WikiSaikouError.isBadTokenError({
        data: { login: { result: 'NeedToken' } },
      })
    ).to.equal(true)
    expect(
      WikiSaikouError.isBadTokenError({
        login: { result: 'Success' },
      })
    ).to.equal(false)
  })

  it('retries postWithToken on login NeedToken and WrongToken responses', async () => {
    const mockServer = createMockServer()
    let loginPostCalls = 0
    const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method.toUpperCase() === 'POST') {
        loginPostCalls++
        if (loginPostCalls === 1) {
          return new Response(
            JSON.stringify({
              login: { result: 'NeedToken', token: 'fresh+\\' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
        if (loginPostCalls === 2) {
          return new Response(
            JSON.stringify({
              login: { result: 'WrongToken' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        }
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: customFetch as any },
    })

    const res = await api.postWithToken(
      'login',
      {
        action: 'login',
        lgname: MOCK_MW_USERNAME,
        lgpassword: MOCK_MW_PASSWORD,
      },
      { tokenName: 'lgtoken', noCache: true }
    )
    expect(res.data.login.result).to.equal('Success')
    expect(loginPostCalls).to.equal(3)
  })

  it('redacts lgpassword from error cause when login token retries are exhausted', async () => {
    const mockServer = createMockServer()
    const secretPassword = 'super-secret-password-123'
    const customFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (method.toUpperCase() === 'POST') {
        return new Response(
          JSON.stringify({
            login: { result: 'WrongToken' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return mockServer.mockFetch(input as any, init)
    }

    const api = new MediaWikiApi({
      baseURL: MOCK_API_ENDPOINT_URL.href,
      fexiosConfigs: { fetch: customFetch as any },
    })

    let caughtError: any
    try {
      await api.postWithToken(
        'login',
        {
          action: 'login',
          lgname: 'TestBot',
          lgpassword: secretPassword,
        },
        { tokenName: 'lgtoken', noCache: true, retry: 2 }
      )
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).to.be.instanceOf(WikiSaikouError)
    const apiErr = caughtError.cause
    expect(apiErr?.name).to.equal('MediaWikiApiError')
    expect(apiErr?.cause?.data?.login?.result).to.equal('WrongToken')
    expect(apiErr?.cause?.rawRequest).to.equal(undefined)
    expect(apiErr?.cause?.request?.rawRequest).to.equal(undefined)

    const body = apiErr?.cause?.request?.body
    const bodyLgPassword =
      typeof body?.get === 'function'
        ? body.get('lgpassword')
        : body?.lgpassword
    const bodyLgName =
      typeof body?.get === 'function' ? body.get('lgname') : body?.lgname
    expect(bodyLgPassword).to.equal('[REDACTED]')
    expect(bodyLgName).to.equal('TestBot')
    expect(JSON.stringify(caughtError)).to.not.include(secretPassword)
  })

  it('keeps ctx fields and redacts top-level aliases in sanitized causes', async () => {
    const api = new MediaWikiApi({
      baseURL: 'https://example.org/w/api.php',
      throwOnApiError: true,
      fexiosConfigs: {
        fetch: (async () =>
          new Response(
            JSON.stringify({ errors: [{ code: 'x', text: 'boom' }] }),
            { headers: { 'Content-Type': 'application/json' } }
          )) as any,
      },
    })
    const err: any = await api
      .post({ action: 'login', lgname: 'u', lgpassword: 'secret-1' })
      .catch((e) => e)
    const ctx = err.cause
    expect(ctx.method).to.equal('post')
    expect(ctx.url).to.be.a('string').and.not.empty
    expect(ctx.rawRequest).to.equal(undefined)
    expect(ctx.request.body.get('lgpassword')).to.equal('[REDACTED]')
    expect(ctx.body.get('lgpassword')).to.equal('[REDACTED]')
    expect(String(ctx.query)).to.not.include('secret-1')
  })

  it('redacts the request ctx of FexiosError on network failure', async () => {
    const api = new MediaWikiApi({
      baseURL: 'https://example.org/w/api.php',
      fexiosConfigs: {
        fetch: (async () => {
          throw new TypeError('network down')
        }) as any,
      },
    })
    const err: any = await api
      .post({ action: 'login', lgname: 'u', lgpassword: 'secret-2' })
      .catch((e) => e)
    expect(err.name).to.equal('FexiosError')
    expect(err.context.request.body.get('lgpassword')).to.equal('[REDACTED]')
    expect(err.context.rawRequest).to.equal(undefined)
  })
})
