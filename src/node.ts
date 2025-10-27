import { FexiosConfigs } from 'fexios'
import { WikiSaikou, MwApiParams, WikiSaikouConfig } from './WikiSaikou.js'
import installCookieJar, { CookieJar } from './plugins/cookie-jar.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'

export * from './WikiSaikou.js'
export * from './plugins/cookie-jar.js'

/**
 * MediaWiki Api
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikou {
  readonly cookieJar!: CookieJar
  constructor(config?: WikiSaikouConfig)
  /** @deprecated Use `new MediaWikiApi(config)` instead */
  constructor(
    baseURL: string,
    options?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  )
  constructor(
    configOrBaseURL?: WikiSaikouConfig | string,
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
