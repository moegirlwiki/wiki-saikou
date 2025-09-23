import { FexiosConfigs } from 'fexios'
import {
  WikiSaikou,
  MwApiParams,
  WikiSaikouError,
  WikiSaikouErrorCode,
} from './WikiSaikou.js'
import installCookieJar, { CookieJar } from './utils/cookie-jar.js'
import { TokenRetryOptions } from './utils/with-retry.js'

export * from './WikiSaikou.js'
export * from './utils/cookie-jar.js'

/**
 * MediaWiki Api
 * Provides the API call methods similar to `mw.Api` at Node.js applications
 *
 * @author Dragon-Fish <dragon-fish@qq.com>
 * @license MIT
 */
export class MediaWikiApi extends WikiSaikou {
  readonly cookieJar!: CookieJar

  private credentials = {
    username: '',
    password: '',
    assertUser: '',
  }

  constructor(
    baseURL: string,
    options?: Partial<FexiosConfigs>,
    defaultParams?: MwApiParams
  ) {
    super(baseURL, options, defaultParams)
    installCookieJar(this)
    this.request.on('beforeRequest', (ctx) => {
      if (this.credentials.assertUser) {
        ;(ctx.query as MwApiParams).assertuser = this.credentials.assertUser
      }
      return ctx
    })
  }

  async login(
    lgname: string,
    lgpassword: string,
    params?: MwApiParams,
    postOptions?: { retry?: number; noCache?: boolean } & TokenRetryOptions
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
    this.credentials.username = lgname
    this.credentials.password = lgpassword
    this.defaultOptions.credentials = 'include'

    postOptions = postOptions || {}
    postOptions.retry ??= 3
    // For compatibility
    postOptions.maxRetries ??= postOptions.retry

    return this.postWithToken<{
      login: {
        result: 'Success' | 'NeedToken' | 'WrongToken' | 'Failed'
        token?: string
        reason?: {
          code: string
          text: string
        }
        lguserid: number
        lgusername: string
      }
    }>(
      'login',
      {
        action: 'login',
        lgname,
        lgpassword,
        ...params,
      },
      { tokenName: 'lgtoken', ...postOptions }
    )
      .then((res) => {
        const data = res.data
        if (data?.login?.result !== 'Success') {
          throw new WikiSaikouError(
            WikiSaikouErrorCode.LOGIN_FAILED,
            data?.login?.reason?.text ||
              data?.login?.result ||
              'Login failed with unknown reason',
            res
          )
        }
        this.credentials.assertUser = data.login.lgusername
        return data.login
      })
      .catch((err) => {
        if (err instanceof WikiSaikouError) {
          throw err
        } else {
          throw new WikiSaikouError(
            WikiSaikouErrorCode.HTTP_ERROR,
            "The server returns an error, but it doesn't seem to be caused by MediaWiki",
            err
          )
        }
      })
  }

  logout(): Promise<void> {
    this.credentials.assertUser = ''
    this.credentials.username = ''
    this.credentials.password = ''
    this.cookieJar.clear()
    return Promise.resolve()
  }

  reAuthorize() {
    if (this.credentials.username && this.credentials.password) {
      return this.login(this.credentials.username, this.credentials.password)
    }
    return Promise.resolve()
  }
}

export { MediaWikiApi as MwApi }
