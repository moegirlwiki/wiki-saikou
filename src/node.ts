import { FexiosConfigs } from 'fexios'
import { MwApiBase, MwApiParams } from './MediaWikiApi.js'
import installCookieJar, { CookieJar } from './plugins/cookie-jar.js'

export * from './MediaWikiApi.js'
export * from './plugins/cookie-jar.js'

/**
 * MediaWiki Api
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends MwApiBase {
  readonly cookieJar!: CookieJar
  constructor(
    baseURL: string,
    options?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    super(baseURL, options, defaultParams)
    installCookieJar(this)
  }
}

export { MediaWikiApi as MwApi }
