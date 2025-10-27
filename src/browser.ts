import { FexiosConfigs } from 'fexios'
import { WikiSaikouCore, MwApiParams, WikiSaikouInitConfig } from './WikiSaikou.js'
import { resolveLegacyCtor } from './utils/resolveLegacyCtor.js'

export * from './WikiSaikou.js'

/**
 * WikiSaikou
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikouCore {}

/**
 * WikiSaikou for foreign wiki
 * @description Standalone MediaWiki API SDK with `mw.Api`-like API in any environments
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiForeignApi extends WikiSaikouCore {
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
