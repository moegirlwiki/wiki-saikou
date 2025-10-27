import { FexiosConfigs } from 'fexios'
import {
  WikiSaikouCore,
  MwApiParams,
  WikiSaikouInitConfig,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './WikiSaikou.js'
import installCookieJar, { CookieJar } from './plugins/cookie-jar.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'

export * from './WikiSaikou.js'
export * from './plugins/cookie-jar.js'

/**
 * WikiSaikou
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikouCore {
  readonly cookieJar!: CookieJar
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
    installCookieJar(this)
  }

  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams,
    postOptions?: { retry?: number; noCache?: boolean }
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
        ...postOptions,
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
    return data.login
  }
}

export { MediaWikiApi as MwApi }
