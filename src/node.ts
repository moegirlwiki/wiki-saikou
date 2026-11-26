import type { FexiosConfigs, FexiosContext, FexiosFinalContext } from 'fexios'
import { WikiSaikouCore, WikiSaikouInitConfig } from './WikiSaikou.js'
import { CookieJar, type CookieJarItem, pluginCookieJar } from 'fexios/plugins'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import { MwApiParams, MwApiResponse } from './types.js'
import {
  MediaWikiApiError,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './models/errors.js'
import { raceWithSignal } from './utils/useRetry.js'
import { FexiosHookHandler } from 'fexios/types'

const STALE_SESSION_ERROR = Symbol.for('__WIKI_SAIKOU_STALE_SESSION__')
const SESSION_EPOCH_ENV = Symbol.for('__WIKI_SAIKOU_SESSION_EPOCH__')

// re-export for library users
export * from './WikiSaikou.js'
export * from './RestSaikou.js'
export { CookieJar, CookieJarItem }

/**
 * WikiSaikou
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikouCore {
  private autoReloginEnabled = false
  private sessionEpoch = 0
  private requestSessionEpochs = new WeakMap<object, number>()
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
    const config = resolveLegacyCtor(
      configOrBaseURL,
      defaultOptions,
      defaultParams
    )
    super(config)
    this.request.plugin(pluginCookieJar)
    this.request.on(
      'beforeRequest',
      (ctx) => {
        const customEnv = ctx.runtime.customEnv as any
        const explicitEpoch =
          customEnv && typeof customEnv === 'object'
            ? customEnv[SESSION_EPOCH_ENV]
            : undefined
        if (typeof explicitEpoch === 'number') {
          this.requestSessionEpochs.set(ctx.runtime, explicitEpoch)
        } else if (
          this.toStringArray(this.getParam(ctx.request.query, 'meta')).includes('tokens')
        ) {
          this.requestSessionEpochs.set(ctx.runtime, this.sessionEpoch)
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
          throw Object.assign(new Error('Stale session epoch'), {
            [STALE_SESSION_ERROR]: true,
          })
        }
        return ctx
      },
      true
    )
    this.request.on('beforeRequest', (ctx) => this.handleBeforeRequest(ctx))
    this.request.on('afterResponse', (ctx) => this.handleAfterResponse(ctx))
  }

  private canAutoRelogin() {
    return Boolean(this.autoReloginEnabled && this.loginCredentials?.username)
  }

  private getAssertUser() {
    return this.loginCredentials?.username
  }

  private getAutoReloginRetries() {
    return this.loginCredentials?.autoReloginRetries ?? 3
  }

  private getParam(data: any, key: string): unknown {
    if (!data) return undefined
    if (data instanceof URLSearchParams) {
      return data.get(key)
    }
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      return data.get(key)
    }
    return data[key]
  }

  private hasParam(data: any, key: string): boolean {
    if (!data) return false
    if (data instanceof URLSearchParams) {
      return data.has(key)
    }
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      return data.has(key)
    }
    return data[key] !== undefined
  }

  private setParam(data: any, key: string, value: string): void {
    if (data instanceof URLSearchParams) {
      data.set(key, value)
    } else if (typeof FormData !== 'undefined' && data instanceof FormData) {
      data.set(key, value)
    } else {
      data[key] = value
    }
  }

  private getAction(query?: unknown, body?: unknown) {
    const action =
      this.getParam(query, 'action') ?? this.getParam(body, 'action')
    return action === undefined ? undefined : String(action)
  }

  private toStringArray(value: unknown): string[] {
    if (value === undefined || value === null) return []
    if (Array.isArray(value)) {
      return value.map((item) => String(item)).filter(Boolean)
    }
    return String(value)
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  private isLoginTokenRequest(query?: unknown, body?: unknown): boolean {
    const check = (data: unknown) => {
      if (!data) return false
      const action = this.getParam(data, 'action')
      // action=query is required for meta=tokens
      if (action && String(action) !== 'query') return false
      // If action is implicit (undefined), we assume it's NOT query-like enough for this check?
      // MediaWiki requires action=query for tokens.
      if (!action) return false

      const meta = this.toStringArray(this.getParam(data, 'meta'))
      if (!meta.includes('tokens')) return false

      const types = this.toStringArray(this.getParam(data, 'type'))
      return types.includes('login')
    }

    return check(query) || check(body)
  }

  private shouldSkipAutoRelogin(query?: unknown, body?: unknown) {
    const action = this.getAction(query, body)
    if (action === 'login') return true
    if (this.isLoginTokenRequest(query, body)) {
      return true
    }
    return false
  }

  private isAssertUserFailed(data: any) {
    const isAssertFailedCode = (code: string) =>
      code === 'assertuserfailed' || code === 'assertnameduserfailed'
    if (MediaWikiApiError.is(data)) {
      return data.errors.some((error) => isAssertFailedCode(error.code))
    }
    return WikiSaikouError.extractMediaWikiApiErrors(data).some((error) =>
      isAssertFailedCode(error.code)
    )
  }

  private async reloginIfNeeded() {
    if (!this.canAutoRelogin() || !this.loginCredentials) return
    if (this.inflightRelogin) {
      return this.inflightRelogin
    }
    const epoch = this.sessionEpoch
    const { lgname, lgpassword, autoReloginRetries } = this.loginCredentials
    const pending = this.performLogin(
      lgname,
      lgpassword,
      void 0,
      {
        autoRelogin: true,
        autoReloginRetries,
      },
      epoch
    )
      .then(() => undefined)
      .catch((err) => {
        if ((err as any)?.[STALE_SESSION_ERROR]) {
          return undefined
        }
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

    if (this.shouldSkipAutoRelogin(query, body)) return ctx

    if (
      this.hasParam(query, 'assertuser') ||
      this.hasParam(body, 'assertuser')
    ) {
      return ctx
    }

    const assertUser = this.getAssertUser()!

    if (body !== undefined && body !== null) {
      this.setParam(body, 'assertuser', assertUser)
    } else {
      if (!ctx.request.query) {
        ctx.request.query = {}
      }
      this.setParam(ctx.request.query, 'assertuser', assertUser)
    }
    return ctx
  }

  private async handleAfterResponse<T>(
    ctx: FexiosFinalContext<MwApiResponse<T>>
  ): Promise<FexiosFinalContext<MwApiResponse<T>> | Response> {
    if (!this.canAutoRelogin()) return ctx
    const { query, body } = ctx.request
    if (this.shouldSkipAutoRelogin(query, body)) {
      return ctx
    }
    if (
      !this.hasParam(query, 'assertuser') &&
      !this.hasParam(body, 'assertuser')
    ) {
      return ctx
    }
    if (!this.isAssertUserFailed(ctx.data)) return ctx

    const attempt = Number(ctx.runtime.customEnv?.autoReloginAttempt ?? 0)
    const maxAttempts = this.getAutoReloginRetries()
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

    const { rawRequest, ...requestOptions } = ctx.request as any
    const prevEnv = ctx.runtime.customEnv
    const nextEnv =
      prevEnv && typeof prevEnv === 'object' && !Array.isArray(prevEnv)
        ? { ...prevEnv, autoReloginAttempt: attempt + 1 }
        : { autoReloginAttempt: attempt + 1 }

    const retryResponse = await this.request.request({
      ...requestOptions,
      ...(origAbortController ? { abortController: origAbortController } : {}),
      url: ctx.request.url,
      customEnv: nextEnv,
    })

    return retryResponse ?? ctx
  }

  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams,
    postOptions?: {
      retry?: number
      noCache?: boolean
      autoRelogin?: boolean
      autoReloginRetries?: number
    }
  ): Promise<{
    result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'
    token?: string
    reason?: {
      code: string
      text: string
    }
    lguserid: number
    lgusername: string
  }> {
    const loginEpoch = ++this.sessionEpoch
    this.inflightRelogin = undefined
    this.clearInflightTokens()
    return this.performLogin(lgname, lgpassword, params, postOptions, loginEpoch)
  }

  private async performLogin(
    lgname: string,
    lgpassword: string,
    params: MwApiParams | undefined,
    postOptions:
      | {
          retry?: number
          noCache?: boolean
          autoRelogin?: boolean
          autoReloginRetries?: number
        }
      | undefined,
    loginEpoch: number
  ): Promise<{
    result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'
    token?: string
    reason?: {
      code: string
      text: string
    }
    lguserid: number
    lgusername: string
  }> {
    this.config.fexiosConfigs.credentials = 'include'

    const {
      autoRelogin = true,
      autoReloginRetries = 3,
      ...tokenOptions
    } = postOptions || {}
    if (tokenOptions.noCache === undefined) {
      tokenOptions.noCache = true
    }
    const res = await this.postWithToken(
      'login',
      {
        action: 'login',
        lgname,
        lgpassword,
        ...params,
      },
      {
        tokenName: 'lgtoken',
        ...tokenOptions,
        fexiosOptions: {
          customEnv: {
            [SESSION_EPOCH_ENV]: loginEpoch,
          },
        },
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
      throw Object.assign(new Error('Stale session epoch'), {
        [STALE_SESSION_ERROR]: true,
      })
    }

    if (autoRelogin === true) {
      this.autoReloginEnabled = true
      this.loginCredentials = {
        lgname,
        lgpassword,
        username: data?.login?.lgusername,
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
    this.sessionEpoch++
    this.autoReloginEnabled = false
    this.loginCredentials = undefined
    this.inflightRelogin = undefined
    this.clearInflightTokens()
    // optional, tell MediaWiki server to drop the session
    await this.postWithToken('csrf', {
      action: 'logout',
    }).catch(() => {
      // ignore logout errors
    })
    this.tokens.clear()
    this.request.cookieJar?.clear()
  }
}

// alias
export { MediaWikiApi as MwApi, MediaWikiApi as MediaWikiNodeClient }
