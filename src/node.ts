import { FexiosConfigs } from 'fexios'
import {
  WikiSaikouCore,
  MwApiParams,
  WikiSaikouInitConfig,
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
}

export { MediaWikiApi as MwApi }
