import { FexiosConfigs } from 'fexios'
import { MwApiBase, MwApiParams, WikiSaikouConfig } from './MediaWikiApi.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'

export * from './MediaWikiApi.js'

/**
 * MediaWiki Api
 * Provides the API call methods similar to `mw.Api` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends MwApiBase {}

/**
 * MediaWiki Foreign Api
 * Provides the API call methods similar to `mw.ForeignApi` at non-mw environments
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiForeignApi extends MwApiBase {
  /** @deprecated Use `new MediaWikiForeignApi(config)` instead */
  constructor(
    baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  )
  constructor(config?: WikiSaikouConfig)
  constructor(
    configOrBaseURL?: WikiSaikouConfig | string,
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
