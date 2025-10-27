import { WikiSaikou } from '../WikiSaikou.js'

declare module '../WikiSaikou.js' {
  interface WikiSaikou {
    cookieJar: CookieJar
  }
}

/**
 * Cookie对象接口
 */
export interface CookieJarItem {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: Date
  maxAge?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  // 内部字段，用于跟踪maxAge的创建时间
  _createdAt?: Date
}

/**
 * Cookie Jar类，用于管理cookies
 */
export class CookieJar {
  private cookies: Map<string, CookieJarItem> = new Map()

  /**
   * 设置cookie
   */
  setCookie(cookie: CookieJarItem, domain?: string, path?: string): void {
    const key = this.getCookieKey(
      cookie.name,
      domain || cookie.domain,
      path || cookie.path
    )

    // 为maxAge设置创建时间
    const cookieWithTime = {
      ...cookie,
      domain: domain || cookie.domain,
      path: path || cookie.path || '/',
      _createdAt: cookie.maxAge !== undefined ? new Date() : cookie._createdAt,
    }

    this.cookies.set(key, cookieWithTime)
  }

  /**
   * 获取cookie
   */
  getCookie(
    name: string,
    domain?: string,
    path?: string
  ): CookieJarItem | undefined {
    // 首先尝试精确匹配
    const exactKey = this.getCookieKey(name, domain, path)
    let cookie = this.cookies.get(exactKey)

    if (cookie && !this.isCookieExpired(cookie)) {
      return cookie
    }

    // 如果没有精确匹配，尝试模糊匹配
    for (const storedCookie of this.cookies.values()) {
      if (
        storedCookie.name === name &&
        this.isCookieMatch(storedCookie, domain, path) &&
        !this.isCookieExpired(storedCookie)
      ) {
        return storedCookie
      }
    }

    return undefined
  }

  /**
   * 获取所有匹配的cookies
   */
  getCookies(domain?: string, path?: string): CookieJarItem[] {
    const result: CookieJarItem[] = []

    for (const cookie of this.cookies.values()) {
      if (
        this.isCookieMatch(cookie, domain, path) &&
        !this.isCookieExpired(cookie)
      ) {
        result.push(cookie)
      }
    }

    return result
  }

  /**
   * 删除cookie
   */
  deleteCookie(name: string, domain?: string, path?: string): boolean {
    const key = this.getCookieKey(name, domain, path)
    return this.cookies.delete(key)
  }

  /**
   * 清空所有cookies
   */
  clear(): void {
    this.cookies.clear()
  }

  /**
   * 清理过期的cookies
   */
  cleanExpiredCookies(): number {
    let cleanedCount = 0
    const now = new Date()

    for (const [key, cookie] of this.cookies.entries()) {
      if (this.isCookieExpired(cookie)) {
        this.cookies.delete(key)
        cleanedCount++
      }
    }

    return cleanedCount
  }

  /**
   * 获取所有cookies（包括过期的）
   */
  getAllCookies(domain?: string, path?: string): CookieJarItem[] {
    const result: CookieJarItem[] = []

    for (const cookie of this.cookies.values()) {
      if (this.isCookieMatch(cookie, domain, path)) {
        result.push(cookie)
      }
    }

    return result
  }

  /**
   * 从Set-Cookie头解析cookies
   */
  parseSetCookieHeader(
    setCookieHeader: string,
    domain?: string,
    path?: string
  ): void {
    const cookies = setCookieHeader.split(',').map((cookie) => cookie.trim())

    for (const cookieStr of cookies) {
      const cookie = this.parseCookieString(cookieStr)
      if (cookie) {
        this.setCookie(cookie, domain, path)
      }
    }
  }

  /**
   * 生成Cookie头字符串
   */
  getCookieHeader(domain?: string, path?: string): string {
    const cookies = this.getCookies(domain, path)
    return cookies
      .filter((cookie) => !this.isCookieExpired(cookie))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  /**
   * 获取cookie的唯一键
   */
  private getCookieKey(name: string, domain?: string, path?: string): string {
    return `${name}:${domain || '*'}:${path || '/'}`
  }

  /**
   * 检查cookie是否匹配指定的domain和path
   */
  private isCookieMatch(
    cookie: CookieJarItem,
    domain?: string,
    path?: string
  ): boolean {
    if (domain && cookie.domain && !this.isDomainMatch(cookie.domain, domain)) {
      return false
    }

    if (path && cookie.path && !this.isPathMatch(cookie.path, path)) {
      return false
    }

    return true
  }

  /**
   * 检查domain是否匹配
   */
  private isDomainMatch(cookieDomain: string, requestDomain: string): boolean {
    if (cookieDomain === requestDomain) {
      return true
    }

    if (cookieDomain.startsWith('.')) {
      return (
        requestDomain.endsWith(cookieDomain.substring(1)) ||
        requestDomain === cookieDomain.substring(1)
      )
    }

    return false
  }

  /**
   * 检查path是否匹配
   */
  private isPathMatch(cookiePath: string, requestPath: string): boolean {
    if (cookiePath === requestPath) {
      return true
    }

    if (requestPath.startsWith(cookiePath)) {
      return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'
    }

    return false
  }

  /**
   * 检查cookie是否过期
   */
  private isCookieExpired(cookie: CookieJarItem): boolean {
    const now = new Date()

    // 检查expires过期时间
    if (cookie.expires) {
      return now > cookie.expires
    }

    // 检查maxAge过期时间
    if (cookie.maxAge !== undefined && cookie._createdAt) {
      const expirationTime = new Date(
        cookie._createdAt.getTime() + cookie.maxAge * 1000
      )
      return now > expirationTime
    }

    return false
  }

  /**
   * 解析cookie字符串
   */
  private parseCookieString(cookieStr: string): CookieJarItem | null {
    const parts = cookieStr.split(';').map((part) => part.trim())
    if (parts.length === 0) return null

    const [nameValue] = parts
    const equalIndex = nameValue.indexOf('=')
    if (equalIndex === -1) return null

    const name = nameValue.substring(0, equalIndex).trim()
    const value = nameValue.substring(equalIndex + 1).trim()

    const cookie: CookieJarItem = { name, value }

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]
      const equalIndex = part.indexOf('=')

      if (equalIndex === -1) {
        // 没有值的属性
        const attr = part.toLowerCase()
        if (attr === 'secure') {
          cookie.secure = true
        } else if (attr === 'httponly') {
          cookie.httpOnly = true
        }
      } else {
        const attrName = part.substring(0, equalIndex).trim().toLowerCase()
        const attrValue = part.substring(equalIndex + 1).trim()

        switch (attrName) {
          case 'domain':
            cookie.domain = attrValue
            break
          case 'path':
            cookie.path = attrValue
            break
          case 'expires':
            cookie.expires = new Date(attrValue)
            break
          case 'max-age':
            cookie.maxAge = parseInt(attrValue, 10)
            break
          case 'samesite':
            cookie.sameSite = attrValue as 'Strict' | 'Lax' | 'None'
            break
        }
      }
    }

    return cookie
  }
}

/**
 * Cookie Jar插件
 */
function installCookieJar(app: WikiSaikou) {
  const cookieJar = new CookieJar()

  // 请求拦截器：添加cookies到请求头
  app.request.interceptors.request.use((ctx) => {
    const url = new URL(ctx.url!)
    const cookieHeader = cookieJar.getCookieHeader(url.hostname, url.pathname)

    if (cookieHeader) {
      ctx.headers = {
        ...ctx.headers,
        Cookie: cookieHeader,
      }
    }

    return ctx
  })

  // 响应拦截器：解析Set-Cookie头
  app.request.interceptors.response.use((ctx) => {
    const setCookieHeader = ctx.rawResponse?.headers?.get('set-cookie')

    if (setCookieHeader) {
      const url = new URL(ctx.url!)
      cookieJar.parseSetCookieHeader(
        setCookieHeader,
        url.hostname,
        url.pathname
      )
    }

    return ctx
  })

  // 将cookieJar实例添加到app上，方便外部访问
  app.cookieJar = cookieJar

  return app
}

export default installCookieJar
