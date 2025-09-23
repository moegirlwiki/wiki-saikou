import { FexiosConfigs } from 'fexios'
import { WikiSaikou, MwApiParams } from './WikiSaikou.js'
import { TokenRetryOptions } from './utils/with-retry.js'

export * from './WikiSaikou.js'

export type ClientLoginParams = {
  username: string
  password: string
  rememberMe?: boolean
} & (
  | { logincontinue: boolean; loginreturnurl?: never }
  | { loginreturnurl: string; logincontinue?: never }
)

export type ClientLoginResponse = {
  clientlogin:
    | {
        status: 'FAIL' | 'UI'
        message: string
        messagecode: string
        canpreservestate: boolean
      }
    | {
        status: 'PASS'
        username: string
      }
}

/**
 * MediaWiki Api
 * Provides the API call methods similar to `mw.Api`
 * Can be used in MediaWiki or non-MediaWiki websites
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikou {
  constructor(
    baseURL?: string,
    defaultOptions?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    // For MediaWiki browser environment
    if (!baseURL && typeof window === 'object' && (window as any).mw) {
      const { wgServer, wgScriptPath } =
        (window as any).mw?.config?.get(['wgServer', 'wgScriptPath']) || {}
      if (typeof wgServer === 'string' && typeof wgScriptPath === 'string') {
        baseURL = `${wgServer}${wgScriptPath}/api.php`
      }
    }
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL is undefined')
    }
    super(baseURL, defaultOptions, defaultParams)
  }

  /**
   * @see https://www.mediawiki.org/w/api.php?action=help&modules=clientlogin
   */
  async clientLogin(
    params: ClientLoginParams & MwApiParams,
    postOptions?: TokenRetryOptions
  ) {
    const { data } = await this.postWithToken<ClientLoginResponse>(
      'login',
      {
        action: 'clientlogin',
        ...params,
      },
      { tokenName: 'logintoken', ...postOptions }
    )
    return data.clientlogin
  }
}

/**
 * MediaWiki Foreign Api
 * Provides the API call methods similar to `mw.ForeignApi`
 * Can be used in non-MediaWiki websites
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiForeignApi extends MediaWikiApi {
  constructor(
    baseURL: string,
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

declare global {
  interface Window {
    WikiSaikou: {
      MediaWikiApi: typeof MediaWikiApi
      MediaWikiForeignApi: typeof MediaWikiForeignApi
    }
  }
}

if (typeof document !== 'undefined') {
  window.WikiSaikou = {
    MediaWikiApi,
    MediaWikiForeignApi,
  }
}
