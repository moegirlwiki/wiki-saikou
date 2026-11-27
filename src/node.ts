import type {
  FexiosConfigs,
  FexiosContext,
  FexiosFinalContext,
  FexiosRequestOptions,
} from 'fexios'
import { CookieJar, type CookieJarItem, pluginCookieJar } from 'fexios/plugins'
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
export { CookieJar, type CookieJarItem }

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

export interface MediaWikiLoginOptions {
  retry?: number
  noCache?: boolean
  autoRelogin?: boolean
  autoReloginRetries?: number
}

export interface MediaWikiLoginResult {
  result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'
  token?: string
  reason?: { code: string; text: string }
  lguserid: number
  lgusername: string
}

const isAssertFailedCode = (code: string) =>
  code === 'assertuserfailed' || code === 'assertnameduserfailed'

/**
 * Node.js MediaWiki API client with cookie persistence, bot login,
 * session-epoch isolation, and singleflight auto-relogin.
 */
export class MediaWikiApi extends WikiSaikouCore {
  private autoReloginEnabled = false
  private sessionEpoch = 0
  private requestSessionEpochs = new WeakMap<object, number>()
  private loginControllerEpochs = new WeakMap<AbortController, number>()
  private inflightRelogin?: Promise<void>
  private loginCredentials?: {
    lgname: string
    lgpassword: string
    username: string
    autoReloginRetries: number
  }

  constructor(config?: WikiSaikouInitConfig)
  /** @deprecated Use `new MediaWikiApi(config)` instead */
  constructor(
    baseURL: string,
    options?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  )
  constructor(
    configOrBaseURL?: WikiSaikouInitConfig | string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    super(resolveLegacyCtor(configOrBaseURL, defaultOptions, defaultParams))
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
    return Boolean(this.autoReloginEnabled && this.loginCredentials?.username)
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
    if (!this.canAutoRelogin()) return ctx
    const { query, body } = ctx.request

    if (
      this.shouldSkipAutoRelogin(query, body) ||
      hasParam(query, 'assertuser') ||
      hasParam(body, 'assertuser')
    ) {
      return ctx
    }

    const assertUser = this.loginCredentials!.username
    if (body !== undefined && body !== null) {
      setParam(body, 'assertuser', assertUser)
    } else {
      ctx.request.query ??= {}
      setParam(ctx.request.query, 'assertuser', assertUser)
    }
    return ctx
  }

  private async handleAfterResponse<T>(
    ctx: FexiosFinalContext<MwApiResponse<T>>
  ): Promise<FexiosFinalContext<MwApiResponse<T>> | Response> {
    if (!this.canAutoRelogin()) return ctx
    const { query, body } = ctx.request
    if (
      this.shouldSkipAutoRelogin(query, body) ||
      (!hasParam(query, 'assertuser') && !hasParam(body, 'assertuser')) ||
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
    await raceWithSignal(this.reloginIfNeeded(), origSignal)
    if (
      origSignal?.aborted ||
      epoch !== this.sessionEpoch ||
      !this.canAutoRelogin()
    ) {
      return ctx
    }

    const { rawRequest: _rawRequest, ...requestOptions } = ctx.request
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

  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams,
    postOptions?: MediaWikiLoginOptions
  ): Promise<MediaWikiLoginResult> {
    const loginEpoch = this.advanceSessionEpoch()
    return this.performLogin(lgname, lgpassword, params, postOptions, loginEpoch)
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
      ...tokenOptions
    } = postOptions || {}
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
      this.autoReloginEnabled = true
      this.loginCredentials = {
        lgname,
        lgpassword,
        username: data.login.lgusername,
        autoReloginRetries:
          Number.isFinite(autoReloginRetries) && autoReloginRetries >= 0
            ? Math.floor(autoReloginRetries)
            : 3,
      }
    } else if (autoRelogin === false) {
      this.autoReloginEnabled = false
      this.loginCredentials = undefined
    }
    return data.login
  }

  async logout(): Promise<void> {
    this.advanceSessionEpoch()
    this.autoReloginEnabled = false
    this.loginCredentials = undefined
    await this.postWithToken('csrf', { action: 'logout' }).catch(() => {
      // Ignore server-side logout failures
    })
    this.tokens.clear()
    this.request.cookieJar?.clear()
  }
}

export { MediaWikiApi as MwApi, MediaWikiApi as MediaWikiNodeClient }
