import { Context, Hono } from 'hono'

export const MOCK_API_ENDPOINT_URL = new URL('https://wiki-saikou.test/api.php')
export const MOCK_MW_SITE_NAME = 'Fake MediaWiki'
export const MOCK_MW_SITE_INFO = {
  sitename: MOCK_MW_SITE_NAME,
  servername: MOCK_API_ENDPOINT_URL.hostname,
}
export const MOCK_MW_USER_INFO = {
  id: 1,
  name: 'Fake User',
  groups: ['user'],
  rights: ['read', 'write'],
}
export const MOCK_MW_USERNAME = 'TestUser'
export const MOCK_MW_PASSWORD = 'TestPassword123'
export const MOCK_MW_PARSED_HTML = `
<div class="mw-parser-output">
<p><b>bold</b> <i>italic</i> <a href="/wiki/Mainpage">Mainpage</a> Custom Page</p>
</div>
`

export interface MockServerState {
  badtokenTestMode: boolean
  tokenUsageTracker: Map<string, number>
  firstEditAttempt: boolean // Track if this is the first edit attempt in badtoken mode
}

export function createMockServer() {
  // Mock session storage
  const mockSessions: Record<
    string,
    { authenticated: boolean; created: number; username?: string }
  > = {}
  const createSessionId = () => `session_${crypto.randomUUID()}`

  // Mock storage for pages and revisions
  const mockPages: Record<
    string,
    { pageid: number; title: string; revisions: any[] }
  > = {}
  let nextPageId = 1000
  let nextRevId = 2000

  // Mock token storage
  let mockTokenCounter = 0
  const generateNewToken = () =>
    `token_${++mockTokenCounter}_${crypto.randomUUID()}`

  // Track generated tokens for validation
  const validTokens = new Map<string, string>() // type -> token
  const sessionLoginTokens = new Map<string, string>() // sessionId -> login token

  // State for badtoken testing
  const state: MockServerState = {
    badtokenTestMode: false,
    tokenUsageTracker: new Map<string, number>(),
    firstEditAttempt: true,
  }

  const mockApi = new Hono()

  // --- REST API mock (rest.php) ---
  // Minimal routes for testing `WikiSaikouCore.rest()` behavior.
  mockApi.all('/rest.php/v1/page/:title', (c) => {
    const title = c.req.param('title')
    const url = new URL(c.req.url)
    return c.json({
      ok: true,
      // Keep both decoded and raw forms for assertions.
      titleDecoded: title,
      pathname: url.pathname, // percent-encoded path
      query: c.req.query(),
    })
  })

  mockApi.all('/rest.php/v1/html', (c) => {
    const html = `<!doctype html><html><head><title>Mock HTML</title></head><body><h1>Hello</h1></body></html>`
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    })
  })

  // Helper function to parse cookies from request
  const parseCookies = (c: Context): Record<string, string> => {
    const cookieHeader = c.req.header('cookie')
    if (!cookieHeader) return {}

    const cookies: Record<string, string> = {}
    cookieHeader.split(';').forEach((cookie) => {
      const [name, value] = cookie.trim().split('=')
      if (name && value) {
        cookies[name] = value
      }
    })
    return cookies
  }

  // Helper function to get session from cookies
  const getSession = (c: Context) => {
    const cookies = parseCookies(c)
    const sessionId = cookies['wiki_session']
    if (sessionId && mockSessions[sessionId]) {
      return { sessionId, session: mockSessions[sessionId] }
    }
    return null
  }

  const handleQuery = (data: Record<string, any>, c: Context) => {
    const result: any = {
      query: {} as any,
    }
    const meta = data.meta?.split('|') || []
    if (meta.includes('siteinfo')) {
      result.query.general = MOCK_MW_SITE_INFO
    }
    if (meta.includes('userinfo')) {
      const sessionData = getSession(c)
      if (sessionData?.session.authenticated && sessionData.session.username) {
        result.query.userinfo = {
          ...MOCK_MW_USER_INFO,
          name: sessionData.session.username,
        }
      } else {
        result.query.userinfo = MOCK_MW_USER_INFO
      }
    }
    if (meta.includes('tokens')) {
      const tokenTypes = data.type?.split('|') || ['csrf']
      result.query.tokens = {}
      tokenTypes.forEach((type: string) => {
        // Generate new token each time for testing token refresh
        const token = generateNewToken()
        result.query.tokens[`${type}token`] = token
        validTokens.set(type, token)
      })

      // If requesting login token, bind it to the current session (or create one)
      if (tokenTypes.includes('login')) {
        const sessionData = getSession(c)
        const sessionId = sessionData?.sessionId ?? createSessionId()

        if (!sessionData) {
          mockSessions[sessionId] = {
            authenticated: false,
            created: Date.now(),
          }
        }

        const loginToken = result.query.tokens['logintoken']
        if (typeof loginToken === 'string') {
          sessionLoginTokens.set(sessionId, loginToken)
        }

        const response = Response.json(result)
        if (!sessionData) {
          response.headers.set(
            'Set-Cookie',
            `wiki_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`
          )
        }
        return response
      }
    }

    // Handle revision queries
    if (data.revids) {
      const revid = parseInt(data.revids)
      const prop = data.prop?.split('|') || []
      const rvprop = data.rvprop?.split('|') || []

      // Find page with this revision
      const page = Object.values(mockPages).find((p) =>
        p.revisions.some((r) => r.revid === revid)
      )

      if (page) {
        const revision = page.revisions.find((r) => r.revid === revid)
        const pageData: any = {
          pageid: page.pageid,
          title: page.title,
        }

        if (prop.includes('revisions') && revision) {
          pageData.revisions = [{ revid: revision.revid }]
          if (rvprop.includes('user')) {
            pageData.revisions[0].user = revision.user
          }
          if (rvprop.includes('content')) {
            pageData.revisions[0].content = revision.content
          }
        }

        result.query.pages = [pageData]
      }
    }

    return Response.json(result)
  }

  const handleParse = (data: Record<string, any>) => {
    const result = {
      parse: {} as any,
    }
    const prop = data.prop?.split('|') || []
    result.parse.title = data.title
    if (prop.includes('text')) {
      result.parse.text = MOCK_MW_PARSED_HTML
    }
    if (prop.includes('wikitext')) {
      result.parse.wikitext = data.text || ''
    }
    if (prop.includes('links')) {
      result.parse.links = [
        {
          title: 'Mainpage',
          url: '/wiki/Mainpage',
        },
      ]
    }
    return Response.json(result)
  }

  const handleLogin = (data: Record<string, any>, c: Context) => {
    const { lgname, lgpassword, lgtoken } = data

    // Validate that request has a valid session (created when token was requested)
    const sessionData = getSession(c)
    if (!sessionData) {
      return Response.json({
        login: {
          result: 'Failed',
          reason: {
            text: 'No valid session',
          },
        },
      })
    }

    // Validate token matches
    const validLoginToken =
      sessionLoginTokens.get(sessionData.sessionId) || validTokens.get('login')
    if (!lgtoken || !validLoginToken || lgtoken !== validLoginToken) {
      return Response.json({
        login: {
          result: 'Failed',
          reason: {
            text: 'Invalid token',
          },
        },
      })
    }

    // Simulate login validation
    if (lgname === MOCK_MW_USERNAME && lgpassword === MOCK_MW_PASSWORD) {
      // Mark session as authenticated
      mockSessions[sessionData.sessionId].authenticated = true
      mockSessions[sessionData.sessionId].username = MOCK_MW_USERNAME
      sessionLoginTokens.delete(sessionData.sessionId)

      const response = Response.json({
        login: {
          result: 'Success',
          lguserid: 1,
          lgusername: MOCK_MW_USERNAME,
        },
      })
      // Update session cookie to maintain authentication
      response.headers.set(
        'Set-Cookie',
        `wiki_session=${sessionData.sessionId}; Path=/; HttpOnly; SameSite=Lax`
      )
      return response
    }

    // Login failed
    return Response.json({
      login: {
        result: 'Failed',
        reason: {
          text: 'Incorrect username or password',
        },
      },
    })
  }

  const handleClientLogin = (data: Record<string, any>, c: Context) => {
    const { username, password, logintoken } = data

    // Validate token matches the last issued login token
    const validLoginToken = validTokens.get('login')
    if (!logintoken || !validLoginToken || logintoken !== validLoginToken) {
      return Response.json({
        clientlogin: {
          status: 'FAIL',
          message: 'Invalid token',
          messagecode: 'invalidtoken',
          canpreservestate: true,
        },
      })
    }

    // For simplicity in browser tests, do not require cookie-based session here
    if (username === MOCK_MW_USERNAME && password === MOCK_MW_PASSWORD) {
      // If a session exists, mark it authenticated; otherwise ignore
      const sessionData = getSession(c)
      if (sessionData) {
        mockSessions[sessionData.sessionId].authenticated = true
      }
      return Response.json({
        clientlogin: {
          status: 'PASS',
          username: MOCK_MW_USERNAME,
        },
      })
    }

    return Response.json({
      clientlogin: {
        status: 'FAIL',
        message: 'Incorrect username or password',
        messagecode: 'wrongpassword',
        canpreservestate: true,
      },
    })
  }

  const handleEdit = (data: Record<string, any>, c: Context) => {
    const { title, text, token, summary } = data

    // Validate session - user must be logged in to edit
    const sessionData = getSession(c)
    if (!sessionData || !sessionData.session.authenticated) {
      return Response.json({
        error: {
          code: 'notloggedin',
          info: 'You must be logged in to edit pages',
        },
      })
    }

    // Validate token exists
    if (!token) {
      return Response.json({
        error: {
          code: 'badtoken',
          info: 'Invalid token',
        },
      })
    }

    // Get or create page
    let page = mockPages[title]
    if (!page) {
      page = {
        pageid: nextPageId++,
        title: title,
        revisions: [],
      }
      mockPages[title] = page
    }

    // Create new revision
    const newRevId = nextRevId++
    const revision = {
      revid: newRevId,
      user: MOCK_MW_USERNAME,
      content: text,
      summary: summary || '',
      timestamp: new Date().toISOString(),
    }
    page.revisions.push(revision)

    return Response.json({
      edit: {
        result: 'Success',
        pageid: page.pageid,
        title: page.title,
        newrevid: newRevId,
        oldrevid:
          page.revisions.length > 1
            ? page.revisions[page.revisions.length - 2].revid
            : 0,
      },
    })
  }

  const handleTestBadtoken = (data: Record<string, any>, c: Context) => {
    const { token } = data

    // Validate session
    const sessionData = getSession(c)
    if (!sessionData || !sessionData.session.authenticated) {
      return Response.json({
        error: {
          code: 'notloggedin',
          info: 'You must be logged in to test badtoken',
        },
      })
    }

    // For testing badtoken scenarios, return badtoken on first attempt only
    if (state.badtokenTestMode) {
      if (state.firstEditAttempt) {
        state.firstEditAttempt = false
        return Response.json({
          error: {
            code: 'badtoken',
            info: 'Invalid token',
          },
        })
      }
    }

    // Validate token exists
    if (!token) {
      return Response.json({
        error: {
          code: 'badtoken',
          info: 'Invalid token',
        },
      })
    }

    // Success
    return Response.json({
      success: {
        result: 'Success',
        message: 'Token validated successfully',
      },
    })
  }

  const handleTestError = (data: Record<string, any>) => {
    const payload = {
      error: {
        code: 'testerror',
        info: 'This is a test mediawiki error',
      },
    }
    // if httpError is truthy, respond with non-2xx status (e.g., 400)
    if (
      data.httpError === '1' ||
      data.httpError === 1 ||
      data.httpError === true
    ) {
      return Response.json(payload, { status: 400 })
    }
    // otherwise return 200 with error field to simulate core API behavior
    return Response.json(payload)
  }

  const handleTestSessionStatus = () => {
    const authenticatedSessions = Object.values(mockSessions).filter(
      (session) => session.authenticated
    ).length
    return Response.json({
      status: {
        authenticatedSessions,
      },
    })
  }

  const handleLogout = (_data: Record<string, any>, c: Context) => {
    const sessionData = getSession(c)
    if (sessionData) {
      mockSessions[sessionData.sessionId].authenticated = false
      mockSessions[sessionData.sessionId].username = undefined
      sessionLoginTokens.delete(sessionData.sessionId)
    }
    return Response.json({
      logout: {
        result: 'Success',
      },
    })
  }

  const handleTestDropLogin = (_data: Record<string, any>, c: Context) => {
    const sessionData = getSession(c)
    if (!sessionData) {
      return Response.json({
        error: {
          code: 'notloggedin',
          info: 'No active session to drop',
        },
      })
    }
    mockSessions[sessionData.sessionId].authenticated = false
    mockSessions[sessionData.sessionId].username = undefined
    return Response.json({
      success: {
        result: 'Success',
        message: 'Session dropped',
      },
    })
  }

  mockApi.all('/api.php', async (c) => {
    const query = c.req.query()
    const body = await c.req.parseBody()
    const data = {
      ...query,
      ...body,
    }

    const action = data.action
    let response: Response
    if (action !== 'login' && action !== 'testDropLogin' && data.assertuser) {
      const sessionData = getSession(c)
      const username = String(data.assertuser)
      if (
        !sessionData ||
        !sessionData.session.authenticated ||
        sessionData.session.username !== username
      ) {
        response = await c.json(
          {
            error: {
              code: 'assertnameduserfailed',
              info: 'You are no longer logged in as "TestUser", so the action could not be completed.',
            },
          },
          200
        )
        return response
      }
    }
    switch (action) {
      case 'query':
        response = await handleQuery(data, c)
        break
      case 'parse':
        response = await handleParse(data)
        break
      case 'login':
        response = await handleLogin(data, c)
        break
      case 'clientlogin':
        response = await handleClientLogin(data, c)
        break
      case 'edit':
        response = await handleEdit(data, c)
        break
      case 'testBadtoken':
        response = await handleTestBadtoken(data, c)
        break
      case 'testError':
        response = await handleTestError(data)
        break
      case 'testSessionStatus':
        response = await handleTestSessionStatus()
        break
      case 'logout':
        response = await handleLogout(data, c)
        break
      case 'testDropLogin':
        response = await handleTestDropLogin(data, c)
        break
      default:
        response = await c.json({ error: 'Not found' }, 404)
    }

    if (data.origin?.toString()?.startsWith('https://')) {
      response.headers.set(
        'access-control-allow-origin',
        data.origin.toString()
      )
    }
    return response
  })

  const mockFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const req = new Request(input, init)
    return mockApi.fetch(req)
  }

  return {
    mockFetch,
    state,
    enableBadtokenTestMode() {
      state.badtokenTestMode = true
      state.tokenUsageTracker.clear()
      state.firstEditAttempt = true
    },
    disableBadtokenTestMode() {
      state.badtokenTestMode = false
      state.tokenUsageTracker.clear()
      state.firstEditAttempt = true
    },
  }
}

// Default instance for backward compatibility
const defaultServer = createMockServer()
export const mockFetch = defaultServer.mockFetch
export const enableBadtokenTestMode = () =>
  defaultServer.enableBadtokenTestMode()
export const disableBadtokenTestMode = () =>
  defaultServer.disableBadtokenTestMode()
