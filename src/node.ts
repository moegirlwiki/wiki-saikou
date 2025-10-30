import { FexiosConfigs } from 'fexios'
import { WikiSaikouCore, WikiSaikouInitConfig } from './WikiSaikou.js'
import { CookieJar, type CookieJarItem, pluginCookieJar } from 'fexios/plugins'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'
import { MwApiParams } from './types.js'
import { WikiSaikouError, WikiSaikouErrorCode } from './models/errors.js'

// re-export for library users
export * from './WikiSaikou.js'
export { CookieJar, CookieJarItem }

/**
 * WikiSaikou
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikouCore {
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

// alias
export { MediaWikiApi as MwApi }
