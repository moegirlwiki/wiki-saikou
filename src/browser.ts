import { FexiosConfigs } from 'fexios'
import {
  WikiSaikouCore,
  MwApiParams,
  WikiSaikouInitConfig,
  MediaWikiApiError,
  MwApiResponse,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './WikiSaikou.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'

export * from './WikiSaikou.js'

export interface ClientLoginOptions extends MwApiParams {
  rememberMe?: boolean
  loginmessageformat?: string
  loginreturnurl?: string
  logincontinue?: boolean
}
export type ClientLoginResult =
  | { status: 'PASS'; username: string }
  | {
      status: 'FAIL'
      username: never
      message: string
      messagecode: string
      canpreservestate: boolean
    }

/**
 * WikiSaikou
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikouCore {
  async clientLogin(
    username: string,
    password: string,
    params?: ClientLoginOptions
  ) {
    params ||= {}
    if (!params.logincontinue && !params.loginreturnurl) {
      params.loginreturnurl = location?.origin
    }
    const res = await this.postWithToken<{
      clientlogin: ClientLoginResult
    }>(
      'login',
      {
        action: 'clientlogin',
        username,
        password,
        ...params,
      },
      {
        tokenName: 'logintoken',
      }
    )
    if (res?.data?.clientlogin?.status === 'PASS') {
      return res.data.clientlogin
    } else {
      throw new WikiSaikouError(
        WikiSaikouErrorCode.LOGIN_FAILED,
        res.data.clientlogin.message,
        res
      )
    }
  }
}

/**
 * WikiSaikou for foreign wiki
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiForeignApi extends MediaWikiApi {
  /** @deprecated Use `new MediaWikiForeignApi(config)` instead */
  constructor(
    baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  )
  constructor(config?: WikiSaikouInitConfig)
  constructor(
    configOrBaseURL?: WikiSaikouInitConfig | string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    const config = resolveLegacyCtor(
      configOrBaseURL,
      {
        credentials: 'include',
        mode: 'cors',
        ...defaultOptions,
      },
      {
        origin: location.origin,
        ...defaultParams,
      }
    )
    super(config)
  }
}

// Aliases
export { MediaWikiApi as MwApi, MediaWikiForeignApi as ForeignApi }
