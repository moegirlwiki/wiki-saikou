import { WikiSaikouCore } from '../WikiSaikou.js'

declare module '../WikiSaikou.js' {
  interface WikiSaikouCore {
    cookieJar: CookieJar
  }
}

/**
 * Cookie object interface
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
  // Internal field to track creation time when maxAge is set
  _createdAt?: Date
}

/**
 * Cookie Jar class to manage cookies
 */
export class CookieJar {
  private cookies: Map<string, CookieJarItem> = new Map()

  /**
   * Set a cookie
   */
  setCookie(cookie: CookieJarItem, domain?: string, path?: string): void {
    const key = this.getCookieKey(
      cookie.name,
      domain || cookie.domain,
      path || cookie.path
    )

    // Set creation time if maxAge is provided
    const cookieWithTime = {
      ...cookie,
      domain: domain || cookie.domain,
      path: path || cookie.path || '/',
      _createdAt: cookie.maxAge !== undefined ? new Date() : cookie._createdAt,
    }

    this.cookies.set(key, cookieWithTime)
  }

  /**
   * Get a cookie
   */
  getCookie(
    name: string,
    domain?: string,
    path?: string
  ): CookieJarItem | undefined {
    // Try exact match first
    const exactKey = this.getCookieKey(name, domain, path)
    let cookie = this.cookies.get(exactKey)

    if (cookie && !this.isCookieExpired(cookie)) {
      return cookie
    }

    // If not found, try fuzzy match
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
   * Get all matching cookies
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
   * Delete a cookie
   */
  deleteCookie(name: string, domain?: string, path?: string): boolean {
    const key = this.getCookieKey(name, domain, path)
    return this.cookies.delete(key)
  }

  /**
   * Clear all cookies
   */
  clear(): void {
    this.cookies.clear()
  }

  /**
   * Clean expired cookies
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
   * Get all cookies (including expired ones)
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
   * Parse cookies from Set-Cookie header
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
   * Generate Cookie header string
   */
  getCookieHeader(domain?: string, path?: string): string {
    const cookies = this.getCookies(domain, path)
    return cookies
      .filter((cookie) => !this.isCookieExpired(cookie))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  /**
   * Get the unique key for a cookie
   */
  private getCookieKey(name: string, domain?: string, path?: string): string {
    return `${name}:${domain || '*'}:${path || '/'}`
  }

  /**
   * Check if cookie matches the given domain and path
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
   * Check if domain matches
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
   * Check if path matches
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
   * Check if cookie is expired
   */
  private isCookieExpired(cookie: CookieJarItem): boolean {
    const now = new Date()

    // Check expires attribute
    if (cookie.expires) {
      return now > cookie.expires
    }

    // Check maxAge expiration time
    if (cookie.maxAge !== undefined && cookie._createdAt) {
      const expirationTime = new Date(
        cookie._createdAt.getTime() + cookie.maxAge * 1000
      )
      return now > expirationTime
    }

    return false
  }

  /**
   * Parse cookie string
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
        // Attributes without value
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
 * Cookie Jar plugin
 */
function installCookieJar(app: WikiSaikouCore) {
  const cookieJar = new CookieJar()

  // Request interceptor: add cookies to request headers
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

  // Response interceptor: parse Set-Cookie header
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

  // Expose cookieJar instance on app for external access
  app.cookieJar = cookieJar

  return app
}

export default installCookieJar
