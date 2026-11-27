import 'dotenv/config'
import { describe, expect, it } from 'vitest'
import { env } from 'process'
import { MediaWikiApi, createFexiosSaikou } from '@/node.js'
import {
  MOCK_API_ENDPOINT_URL,
  MOCK_MW_SITE_NAME,
  mockFetch,
} from './__mock__/mwApiServer.js'

const api = new MediaWikiApi({
  baseURL: MOCK_API_ENDPOINT_URL.href,
  fexiosConfigs: {
    headers: {
      'api-user-agent': env.API_USER_AGENT || '',
    },
    fetch: mockFetch,
  },
})

describe('MediaWikiApi Core (basic)', () => {
  it('[GET] siteinfo', async () => {
    const { data } = await api.get({ action: 'query', meta: 'siteinfo' })
    expect(data.query.general).to.be.an('object')
    const info = data.query.general
    expect(info.sitename).to.eq(MOCK_MW_SITE_NAME)
    expect(info.servername).to.eq(MOCK_API_ENDPOINT_URL.hostname)
  })

  it('[GET] array as param', async () => {
    const { data } = await api.get({
      action: 'query',
      meta: ['siteinfo', 'userinfo'],
    })
    expect(data.query.general).to.not.be.undefined
    expect(data.query.userinfo).to.not.be.undefined
  })

  it('[POST] parse', async () => {
    const { data } = await api.post({
      action: 'parse',
      title: 'Custom Page',
      text: `'''bold''' ''italic'' [[Mainpage]] {{PAGENAME}}`,
      prop: ['text', 'wikitext', 'links'],
      disablelimitreport: 1,
    })
    expect(data.parse.title).to.eq('Custom Page')
    expect(data.parse.text).to.includes('<b>bold</b>')
    expect(data.parse.text).to.includes('<i>italic</i>')
    expect(data.parse.links).to.be.an('array')
  })

  it('resolve legacy init options', () => {
    const legacy = new MediaWikiApi(
      'foo',
      { query: { bar: 'bar' } },
      { baz: 'baz' }
    )
    const modern = new MediaWikiApi({
      baseURL: 'foo',
      fexiosConfigs: {
        query: { bar: 'bar' },
      },
      defaultParams: { baz: 'baz' },
    })
    expect(legacy.config).to.deep.equal(modern.config)
  })

  it('propagates fexiosConfigs (headers, fetch, etc.) to api.request', async () => {
    const captured: {
      url: string
      method: string
      apiUa: string | null
      ua: string | null
      xExtra: string | null
    }[] = []
    const customApi = new MediaWikiApi({
      baseURL: 'https://example.org/w/api.php',
      fexiosConfigs: {
        headers: {
          'api-user-agent': 'WikiSaikouTestBot/1.0',
          'User-Agent': 'BaseUA/1.0',
        },
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as Request).url
          const method =
            init?.method ?? (input instanceof Request ? input.method : 'GET')
          const headers = new Headers(
            input instanceof Request ? input.headers : init?.headers
          )
          captured.push({
            url,
            method,
            apiUa: headers.get('api-user-agent'),
            ua: headers.get('user-agent'),
            xExtra: headers.get('x-extra'),
          })
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        },
      },
    })

    const res = await customApi.request.post('/index.php', {
      action: 'edit',
      title: 'Test',
    })
    expect(res.data).to.deep.equal({ ok: true })

    await customApi.request.post(
      '/index.php',
      { action: 'purge' },
      { headers: { 'user-agent': 'OverrideUA/2.0', 'x-extra': 'yes' } }
    )

    expect(captured).to.deep.equal([
      {
        url: 'https://example.org/index.php',
        method: 'POST',
        apiUa: 'WikiSaikouTestBot/1.0',
        ua: 'BaseUA/1.0',
        xExtra: null,
      },
      {
        url: 'https://example.org/index.php',
        method: 'POST',
        apiUa: 'WikiSaikouTestBot/1.0',
        ua: 'OverrideUA/2.0',
        xExtra: 'yes',
      },
    ])

    // Headers instance & duplicate tuple headers through MediaWikiApi constructor (resolveLegacyCtor)
    const ctorCaptured: { ua: string | null; multi: string | null }[] = []
    const makeCaptureFetch = () => async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers
      )
      ctorCaptured.push({
        ua: headers.get('api-user-agent'),
        multi: headers.get('x-multi'),
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const apiWithHeadersInstance = new MediaWikiApi({
      baseURL: 'https://example.org/w/api.php',
      fexiosConfigs: {
        headers: new Headers({ 'api-user-agent': 'CtorHeaders/1.0' }),
        fetch: makeCaptureFetch(),
      },
    })
    await apiWithHeadersInstance.request.post('/index.php', { action: 'view' })

    const apiWithTupleHeaders = new MediaWikiApi({
      baseURL: 'https://example.org/w/api.php',
      fexiosConfigs: {
        headers: [
          ['x-multi', 'first'],
          ['X-Multi', 'second'],
        ],
        fetch: makeCaptureFetch(),
      },
    })
    await apiWithTupleHeaders.request.post('/index.php', { action: 'view' })

    expect(ctorCaptured).to.deep.equal([
      { ua: 'CtorHeaders/1.0', multi: null },
      { ua: null, multi: 'first, second' },
    ])

    // createFexiosSaikou accepts URL baseURL and Headers directly without casts
    let directUa: string | null = null
    const fexiosDirect = createFexiosSaikou({
      baseURL: new URL('https://example.org/w/api.php'),
      headers: new Headers({ 'api-user-agent': 'DirectHeaders/1.0' }),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(
          input instanceof Request ? input.headers : init?.headers
        )
        directUa = headers.get('api-user-agent')
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })
    await fexiosDirect.post('/index.php', { title: 'Direct' })
    expect(directUa).to.equal('DirectHeaders/1.0')
  })

  it('keeps api.request and api.get/post on one config source', async () => {
    const seen: { credentials: string; ua: string | null }[] = []
    const api = new MediaWikiApi({
      baseURL: 'https://example.org/w/api.php',
      fexiosConfigs: {
        headers: { 'x-ua': 'A' },
        fetch: (async (req: Request) => {
          seen.push({ credentials: req.credentials, ua: req.headers.get('x-ua') })
          return new Response('{}', {
            headers: { 'Content-Type': 'application/json' },
          })
        }) as any,
      },
    })

    // Runtime mutation of config.fexiosConfigs reaches direct requests
    api.config.fexiosConfigs.credentials = 'include'
    await api.request.post('/index.php', { action: 'view' })
    // ...and removals stop being sent through api.get
    delete (api.config.fexiosConfigs.headers as Record<string, string>)['x-ua']
    await api.get({ action: 'query' })

    expect(seen).to.deep.equal([
      { credentials: 'include', ua: 'A' },
      { credentials: 'include', ua: null },
    ])
  })
})
