import { FexiosConfigs } from 'fexios'
import { MwApiBase, MwApiParams } from './MediaWikiApi.js'

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
  constructor(
    baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    super(
      baseURL,
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
  }
}

// Aliases
export { MediaWikiApi as MwApi, MediaWikiForeignApi as ForeignApi }
