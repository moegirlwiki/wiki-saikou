import type {
  FexiosConfigs,
  FexiosContext,
  FexiosFinalContext,
  FexiosRequestOptions,
} from 'fexios'
import {
  CookieJar,
  type CookieJarImportItem,
  type CookieJarItem,
  type SerializedCookieJarItem,
  pluginCookieJar,
} from 'fexios/plugins'
import type { FexiosHookHandler } from 'fexios/types'
import { WikiSaikouCore, type WikiSaikouInitConfig } from './WikiSaikou.js'
import { raceWithSignal } from './internals/abort.js'
import {
  getParam,
  hasParam,
  setParam,
  toStringArray,
} from './internals/params.js'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './models/errors.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import type { MwApiParams, MwApiResponse } from './types.js'

// Re-export for library users
export * from './WikiSaikou.js'
export * from './RestSaikou.js'
export {
  CookieJar,
  type CookieJarItem,
  type SerializedCookieJarItem,
  type CookieJarImportItem,
}

const STALE_SESSION_ERROR = Symbol.for('__WIKI_SAIKOU_STALE_SESSION__')

type StaleSessionError = Error & { [STALE_SESSION_ERROR]?: boolean }

function createStaleSessionError(): StaleSessionError {
  return Object.assign(new Error('Stale session epoch'), {
    [STALE_SESSION_ERROR]: true,
  })
}

function isStaleSessionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ((err as StaleSessionError)[STALE_SESSION_ERROR]) return true
  const cause = (err as { cause?: unknown }).cause
  return Boolean(
    cause &&
      typeof cause === 'object' &&
      (cause as StaleSessionError)[STALE_SESSION_ERROR]
  )
}

export type MediaWikiCookieInput =
  | CookieJar
  | string
  | Iterable<CookieJarImportItem>

export interface MediaWikiNodeInitConfig extends WikiSaikouInitConfig {
  /**
   * Callback invoked whenever cookies in `cookieJar` are updated by server
   * `Set-Cookie` headers or cleared by `logout()`.
   */
  onCookiesChange?: (cookieJar: CookieJar) => void
}

export interface MediaWikiLoginOptions {
  retry?: number
  noCache?: boolean
  autoRelogin?: boolean
  autoReloginRetries?: number
  /**
   * Pre-existing cookies to import before logging in.
   * Accepts a `CookieJar`, a JSON string/array from `cookieJar.toJSON()`,
   * or a raw HTTP `Cookie` header string (e.g. `"session=abc; user=123"`).
   */
  cookies?: MediaWikiCookieInput
  /**
   * When `cookies` is provided, verify the session via `action=query&meta=userinfo`
   * before accepting or falling back to credentials.
   * Set to `false` to skip verification (0 startup requests).
   * @default true
   */
  verify?: boolean
  /**
   * Expected MediaWiki username when logging in with `cookies`.
   * - With `verify: true`: verifies `userinfo.name === username` (falls back to
   *   `lgname`/`lgpassword` on mismatch, or throws `LOGIN_FAILED` if no credentials).
   * - With `verify: false`: used for `assertuser` on subsequent requests
   *   (when omitted, generic `assert=user` is attached instead).
   */
  username?: string
}

export interface MediaWikiLoginInput extends MediaWikiLoginOptions {
  lgname?: string
  lgpassword?: string
  params?: MwApiParams
}

export interface MediaWikiLoginResult {
  result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'
  token?: string
  reason?: { code: string; text: string }
  lguserid: number
  lgusername: string
}

type SessionAssert =
  | { kind: 'user' }
  | { kind: 'nameduser'; username: string }

const isAssertFailedCode = (code: string) =>
  code === 'assertuserfailed' || code === 'assertnameduserfailed'

const isLoggedInUserinfo = (
  userinfo: unknown
): userinfo is { id: number; name: string } => {
  if (!userinfo || typeof userinfo !== 'object') return false
  const info = userinfo as Record<string, unknown>
  // formatversion=2 sets `anon: true`; formatversion=1 sets `anon: ""`
  const isAnon = info.anon !== undefined && info.anon !== false
  return (
    !isAnon &&
    typeof info.id === 'number' &&
    info.id > 0 &&
    typeof info.name === 'string' &&
    info.name.length > 0
  )
}

const normalizeAutoReloginRetries = (retries: number | undefined): number =>
  typeof retries === 'number' && Number.isFinite(retries) && retries >= 0
    ? Math.floor(retries)
    : 3

/**
 * Node.js MediaWiki API client with cookie persistence, bot login,
 * cookie session reuse, session-epoch isolation, and singleflight auto-relogin.
 */
export class MediaWikiApi extends WikiSaikouCore {
  onCookiesChange?: (cookieJar: CookieJar) => void

  private sessionAssert?: SessionAssert
  private autoReloginEnabled = false
  private sessionEpoch = 0
  private requestSessionEpochs = new WeakMap<object, number>()
  private loginControllerEpochs = new WeakMap<AbortController, number>()
  private inflightRelogin?: Promise<void>
  private loginCredentials?: {
    lgname: string
    lgpassword: string
    username?: string
    autoReloginRetries: number
  }

  constructor(config?: MediaWikiNodeInitConfig)
  /** @deprecated Use `new MediaWikiApi(config)` instead */
  constructor(
    baseURL: string,
    options?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  )
  constructor(
    configOrBaseURL?: MediaWikiNodeInitConfig | string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    let onCookiesChange: ((cookieJar: CookieJar) => void) | undefined
    let coreArg: WikiSaikouInitConfig | string | undefined = configOrBaseURL
    if (typeof configOrBaseURL === 'object' && configOrBaseURL !== null) {
      const { onCookiesChange: cb, ...rest } = configOrBaseURL
      onCookiesChange = cb
      coreArg = rest
    }
    super(resolveLegacyCtor(coreArg, defaultOptions, defaultParams))
    this.onCookiesChange = onCookiesChange
    this.request.plugin(pluginCookieJar)
    this.attachSessionGuards()
    this.request.on('beforeRequest', (ctx) => this.handleBeforeRequest(ctx))
    this.request.on('afterResponse', (ctx) => this.handleAfterResponse(ctx))
  }

  /**
   * Track session epoch per request runtime in a WeakMap (never mutating
   * caller-provided `customEnv`) so stale login/token responses from an older
   * session cannot overwrite cookies or tokens of a newer session.
   */
  private attachSessionGuards(): void {
    this.request.on(
      'beforeRequest',
      (ctx) => {
        const explicitEpoch = ctx.runtime.abortController
          ? this.loginControllerEpochs.get(ctx.runtime.abortController)
          : undefined
        const isTokensQuery = toStringArray(
          getParam(ctx.request.query, 'meta')
        ).includes('tokens')
        const isLoginAction =
          this.getAction(ctx.request.query, ctx.request.body) === 'login'
        if (
          (explicitEpoch !== undefined || isTokensQuery || isLoginAction) &&
          !this.requestSessionEpochs.has(ctx.runtime)
        ) {
          this.requestSessionEpochs.set(
            ctx.runtime,
            explicitEpoch ?? this.sessionEpoch
          )
        }
        return ctx
      },
      true
    )

    this.request.on(
      'afterResponse',
      (ctx) => {
        const reqEpoch = this.requestSessionEpochs.get(ctx.runtime)
        if (typeof reqEpoch === 'number' && reqEpoch !== this.sessionEpoch) {
          throw createStaleSessionError()
        }
        return ctx
      },
      true
    )
  }

  private advanceSessionEpoch(): number {
    this.sessionEpoch++
    this.inflightRelogin = undefined
    this.clearInflightTokens()
    return this.sessionEpoch
  }

  private canAutoRelogin() {
    return Boolean(this.autoReloginEnabled && this.loginCredentials)
  }

  private getDefaultCookieDomain(): string | undefined {
    try {
      return new URL(this.config.baseURL).hostname
    } catch {
      return undefined
    }
  }

  private hasSetCookieHeader(ctx: FexiosFinalContext<any>): boolean {
    const headers = ctx.response.rawResponse?.headers as
      | (Headers & { getSetCookie?: () => string[] })
      | undefined
    if (!headers) return false
    if (typeof headers.getSetCookie === 'function') {
      return headers.getSetCookie().length > 0
    }
    return Boolean(headers.get('set-cookie'))
  }

  private notifyCookiesChange(): void {
    this.onCookiesChange?.(this.cookieJar)
  }

  private importCookiesInput(cookies: MediaWikiCookieInput): void {
    const defaultDomain = this.getDefaultCookieDomain()
    if (cookies instanceof CookieJar) {
      // Snapshot before clearing in case the caller passed `this.cookieJar` itself.
      const items = cookies.toJSON()
      this.cookieJar.clear()
      this.cookieJar.importCookies(items, defaultDomain, '/')
      return
    }

    this.cookieJar.clear()

    if (typeof cookies === 'string') {
      const trimmed = cookies.trim()
      if (!trimmed) return
      // RFC 6265 cookie names cannot contain `[`, so a leading `[` unambiguously indicates serialized JSON.
      if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed)
        if (!Array.isArray(parsed)) {
          throw new TypeError('Serialized cookies JSON must be an array')
        }
        this.cookieJar.importCookies(parsed, defaultDomain, '/')
      } else {
        this.cookieJar.parseCookieHeader(trimmed, defaultDomain, '/')
      }
      return
    }

    this.cookieJar.importCookies(cookies, defaultDomain, '/')
  }

  private applyCookieSessionState(options: {
    autoRelogin: boolean
    username?: string
    hasCredentials: boolean
    lgname?: string
    lgpassword?: string
    autoReloginRetries: number
  }): void {
    if (options.autoRelogin === false) {
      this.sessionAssert = undefined
      this.autoReloginEnabled = false
      this.loginCredentials = undefined
      return
    }

    this.sessionAssert = options.username
      ? { kind: 'nameduser', username: options.username }
      : { kind: 'user' }

    if (options.hasCredentials && options.lgname && options.lgpassword) {
      this.autoReloginEnabled = true
      this.loginCredentials = {
        lgname: options.lgname,
        lgpassword: options.lgpassword,
        username: options.username,
        autoReloginRetries: options.autoReloginRetries,
      }
    } else {
      this.autoReloginEnabled = false
      this.loginCredentials = undefined
    }
  }

  private getAction(query?: unknown, body?: unknown) {
    const action = getParam(query, 'action') ?? getParam(body, 'action')
    return action === undefined ? undefined : String(action)
  }

  private isLoginTokenRequest(query?: unknown, body?: unknown): boolean {
    const check = (data: unknown) => {
      if (!data) return false
      const action = getParam(data, 'action')
      if (!action || String(action) !== 'query') return false
      if (!toStringArray(getParam(data, 'meta')).includes('tokens')) return false
      return toStringArray(getParam(data, 'type')).includes('login')
    }
    return check(query) || check(body)
  }

  private shouldSkipAutoRelogin(query?: unknown, body?: unknown): boolean {
    return (
      this.getAction(query, body) === 'login' ||
      this.isLoginTokenRequest(query, body)
    )
  }

  private isAssertUserFailed(data: unknown): boolean {
    const errors = MediaWikiApiError.is(data)
      ? data.errors
      : WikiSaikouError.extractMediaWikiApiErrors(data)
    return errors.some((error) => isAssertFailedCode(error.code))
  }

  private async reloginIfNeeded(): Promise<void> {
    if (!this.canAutoRelogin() || !this.loginCredentials) return
    if (this.inflightRelogin) return this.inflightRelogin

    const epoch = this.sessionEpoch
    const { lgname, lgpassword, autoReloginRetries } = this.loginCredentials
    const pending = this.performLogin(
      lgname,
      lgpassword,
      undefined,
      { autoRelogin: true, autoReloginRetries },
      epoch
    )
      .then(() => undefined)
      .catch((err) => {
        if (isStaleSessionError(err)) return undefined
        throw err
      })
      .finally(() => {
        if (this.inflightRelogin === pending) {
          this.inflightRelogin = undefined
        }
      })

    this.inflightRelogin = pending
    return pending
  }

  get cookieJar() {
    return this.request.cookieJar!
  }

  private handleBeforeRequest(
    ctx: FexiosContext
  ): ReturnType<FexiosHookHandler<'beforeRequest'>> {
    if (!this.sessionAssert) return ctx
    const { query, body } = ctx.request

    if (
      this.shouldSkipAutoRelogin(query, body) ||
      hasParam(query, 'assertuser') ||
      hasParam(body, 'assertuser') ||
      hasParam(query, 'assert') ||
      hasParam(body, 'assert')
    ) {
      return ctx
    }

    const [paramKey, paramValue] =
      this.sessionAssert.kind === 'nameduser'
        ? (['assertuser', this.sessionAssert.username] as const)
        : (['assert', 'user'] as const)

    if (body !== undefined && body !== null) {
      setParam(body, paramKey, paramValue)
    } else {
      ctx.request.query ??= {}
      setParam(ctx.request.query, paramKey, paramValue)
    }
    return ctx
  }

  private async handleAfterResponse<T>(
    ctx: FexiosFinalContext<MwApiResponse<T>>
  ): Promise<FexiosFinalContext<MwApiResponse<T>> | Response> {
    if (this.hasSetCookieHeader(ctx)) {
      this.notifyCookiesChange()
    }

    if (!this.canAutoRelogin()) return ctx
    const { query, body } = ctx.request
    const hasAssertParam =
      hasParam(query, 'assertuser') ||
      hasParam(body, 'assertuser') ||
      hasParam(query, 'assert') ||
      hasParam(body, 'assert')
    if (
      this.shouldSkipAutoRelogin(query, body) ||
      !hasAssertParam ||
      !this.isAssertUserFailed(ctx.data)
    ) {
      return ctx
    }

    const attempt = Number(ctx.runtime.customEnv?.autoReloginAttempt ?? 0)
    const maxAttempts = this.loginCredentials?.autoReloginRetries ?? 3
    if (attempt >= maxAttempts) return ctx

    const origAbortController = ctx.runtime.abortController
    const origSignal = origAbortController?.signal
    if (origSignal?.aborted) return ctx

    const epoch = this.sessionEpoch
    const prevAssertUser =
      this.sessionAssert?.kind === 'nameduser'
        ? this.sessionAssert.username
        : undefined
    await raceWithSignal(this.reloginIfNeeded(), origSignal)
    if (
      origSignal?.aborted ||
      epoch !== this.sessionEpoch ||
      !this.canAutoRelogin()
    ) {
      return ctx
    }

    const { rawRequest: _rawRequest, ...requestOptions } = ctx.request
    if (
      prevAssertUser !== undefined &&
      this.sessionAssert?.kind === 'nameduser' &&
      this.sessionAssert.username !== prevAssertUser
    ) {
      if (getParam(requestOptions.body, 'assertuser') === prevAssertUser) {
        setParam(requestOptions.body, 'assertuser', this.sessionAssert.username)
      } else if (
        getParam(requestOptions.query, 'assertuser') === prevAssertUser
      ) {
        setParam(
          requestOptions.query,
          'assertuser',
          this.sessionAssert.username
        )
      }
    }
    const prevEnv = ctx.runtime.customEnv
    const nextEnv =
      prevEnv && typeof prevEnv === 'object' && !Array.isArray(prevEnv)
        ? { ...prevEnv, autoReloginAttempt: attempt + 1 }
        : { autoReloginAttempt: attempt + 1 }

    const retryOptions: Partial<FexiosRequestOptions> & { url: string } = {
      ...requestOptions,
      ...(origAbortController ? { abortController: origAbortController } : {}),
      url: ctx.request.url,
      customEnv: nextEnv,
    }
    return (await this.request.request(retryOptions)) ?? ctx
  }

  async login(options: MediaWikiLoginInput): Promise<MediaWikiLoginResult>
  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams,
    postOptions?: MediaWikiLoginOptions
  ): Promise<MediaWikiLoginResult>
  async login(
    lgnameOrOptions: string | MediaWikiLoginInput,
    lgpassword?: string,
    params?: MwApiParams,
    postOptions?: MediaWikiLoginOptions
  ): Promise<MediaWikiLoginResult> {
    const input: MediaWikiLoginInput =
      typeof lgnameOrOptions === 'string'
        ? {
            ...postOptions,
            lgname: lgnameOrOptions,
            lgpassword,
            params,
          }
        : lgnameOrOptions || {}

    const hasLgname =
      typeof input.lgname === 'string' && input.lgname.length > 0
    const hasLgpassword =
      typeof input.lgpassword === 'string' && input.lgpassword.length > 0
    if (hasLgname !== hasLgpassword) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.LOGIN_FAILED,
        'Both `lgname` and `lgpassword` are required when providing login credentials'
      )
    }

    const hasCredentials = hasLgname && hasLgpassword
    const hasCookies = input.cookies !== undefined
    if (!hasCookies && !hasCredentials) {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.LOGIN_FAILED,
        'Either `cookies` or both `lgname` and `lgpassword` must be provided'
      )
    }

    const loginEpoch = this.advanceSessionEpoch()
    this.sessionAssert = undefined
    this.autoReloginEnabled = false
    this.loginCredentials = undefined

    if (!hasCookies) {
      return this.performLogin(
        input.lgname!,
        input.lgpassword!,
        input.params,
        input,
        loginEpoch
      )
    }

    this.config.fexiosConfigs.credentials = 'include'
    this.tokens.clear()
    this.importCookiesInput(input.cookies!)

    const {
      verify = true,
      username,
      autoRelogin = true,
      autoReloginRetries,
      retry,
    } = input
    const normalizedRetries = normalizeAutoReloginRetries(autoReloginRetries)

    if (!verify) {
      this.applyCookieSessionState({
        autoRelogin,
        username,
        hasCredentials,
        lgname: input.lgname,
        lgpassword: input.lgpassword,
        autoReloginRetries: normalizedRetries,
      })
      return {
        result: 'Success',
        lguserid: 0,
        lgusername: username ?? '',
      }
    }

    const verified = await this.verifyCookieSession(loginEpoch, {
      expectedUsername: username,
      retry,
    })

    if (loginEpoch !== this.sessionEpoch) {
      throw createStaleSessionError()
    }

    if (verified.ok) {
      this.applyCookieSessionState({
        autoRelogin,
        username: verified.lgusername,
        hasCredentials,
        lgname: input.lgname,
        lgpassword: input.lgpassword,
        autoReloginRetries: normalizedRetries,
      })
      return {
        result: 'Success',
        lguserid: verified.lguserid,
        lgusername: verified.lgusername,
      }
    }

    // Clear invalid, expired, or wrong-user cookies so they cannot leak into subsequent requests.
    this.cookieJar.clear()

    if (hasCredentials) {
      return this.performLogin(
        input.lgname!,
        input.lgpassword!,
        input.params,
        input,
        loginEpoch
      )
    }

    throw new WikiSaikouError(
      WikiSaikouErrorCode.LOGIN_FAILED,
      verified.reason,
      verified.cause
    )
  }

  private async verifyCookieSession(
    loginEpoch: number,
    options: { expectedUsername?: string; retry?: number }
  ): Promise<
    | { ok: true; lguserid: number; lgusername: string }
    | { ok: false; reason: string; cause?: unknown }
  > {
    const verifyTag = new AbortController()
    this.loginControllerEpochs.set(verifyTag, loginEpoch)

    let res: FexiosFinalContext<MwApiResponse<any>>
    try {
      res = await this.get(
        { action: 'query', meta: 'userinfo' },
        {
          ...(options.retry !== undefined ? { retry: options.retry } : {}),
          abortController: verifyTag,
        }
      )
    } catch (err) {
      if (MediaWikiApiError.is(err)) {
        return {
          ok: false,
          reason: err.message || 'Cookie session verification failed',
          cause: err,
        }
      }
      throw err
    }

    const errors = WikiSaikouError.extractMediaWikiApiErrors(res.data)
    if (errors.length > 0) {
      return {
        ok: false,
        reason:
          errors.map((e) => e.text || e.code).join('\n') ||
          'Cookie session verification failed',
        cause: res.data,
      }
    }

    const userinfo = res.data?.query?.userinfo
    if (!isLoggedInUserinfo(userinfo)) {
      return {
        ok: false,
        reason: 'Cookie session is not logged in or has expired',
        cause: res.data,
      }
    }

    if (
      options.expectedUsername !== undefined &&
      userinfo.name !== options.expectedUsername
    ) {
      return {
        ok: false,
        reason: `Cookie session belongs to "${userinfo.name}", expected "${options.expectedUsername}"`,
        cause: res.data,
      }
    }

    return {
      ok: true,
      lguserid: userinfo.id,
      lgusername: userinfo.name,
    }
  }

  private async performLogin(
    lgname: string,
    lgpassword: string,
    params: MwApiParams | undefined,
    postOptions: MediaWikiLoginOptions | undefined,
    loginEpoch: number
  ): Promise<MediaWikiLoginResult> {
    if (loginEpoch !== this.sessionEpoch) {
      throw createStaleSessionError()
    }

    this.config.fexiosConfigs.credentials = 'include'

    const {
      autoRelogin = true,
      autoReloginRetries = 3,
      cookies: _cookies,
      verify: _verify,
      username: _username,
      lgname: _lgname,
      lgpassword: _lgpassword,
      params: _params,
      ...tokenOptions
    } = (postOptions || {}) as MediaWikiLoginInput
    if (tokenOptions.noCache === undefined) {
      tokenOptions.noCache = true
    }

    const loginTag = new AbortController()
    this.loginControllerEpochs.set(loginTag, loginEpoch)
    const res = await this.postWithToken(
      'login',
      { action: 'login', lgname, lgpassword, ...params },
      {
        tokenName: 'lgtoken',
        ...tokenOptions,
        fexiosOptions: { abortController: loginTag },
      }
    )

    const data = res?.data
    if (data?.login?.result !== 'Success') {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.LOGIN_FAILED,
        data?.login?.reason?.text ||
          data?.login?.result ||
          'Login failed with unknown reason',
        data
      )
    }

    if (loginEpoch !== this.sessionEpoch) {
      throw createStaleSessionError()
    }

    if (autoRelogin === true) {
      this.sessionAssert = {
        kind: 'nameduser',
        username: data.login.lgusername,
      }
      this.autoReloginEnabled = true
      this.loginCredentials = {
        lgname,
        lgpassword,
        username: data.login.lgusername,
        autoReloginRetries: normalizeAutoReloginRetries(autoReloginRetries),
      }
    } else if (autoRelogin === false) {
      this.sessionAssert = undefined
      this.autoReloginEnabled = false
      this.loginCredentials = undefined
    }
    return data.login
  }

  async logout(): Promise<void> {
    this.advanceSessionEpoch()
    this.sessionAssert = undefined
    this.autoReloginEnabled = false
    this.loginCredentials = undefined
    await this.postWithToken('csrf', { action: 'logout' }).catch(() => {
      // Ignore server-side logout failures
    })
    this.tokens.clear()
    const hadCookies =
      (this.request.cookieJar?.getAllCookies().length ?? 0) > 0
    this.request.cookieJar?.clear()
    if (hadCookies) {
      this.notifyCookiesChange()
    }
  }
}

export { MediaWikiApi as MwApi, MediaWikiApi as MediaWikiNodeClient }
