import { Fexios } from 'fexios'
import {} from '../WikiSaikou.js'
import { MwParamNormalizer } from './MwParamNormalizer.js'
import { WikiSaikouError } from './errors.js'
import { MwTokenName } from '../types.js'

export interface FexiosSaikou extends Fexios {
  _tokens: Map<string, string>
}

const FEXIOS_SAIKOU_MARKER = Symbol.for('__FEXIOS_SAIKOU__')

/**
 * FexiosSaikou
 *
 * A pre-configured Fexios instance with MediaWiki-friendly defaults:
 * - MediaWiki-specific request/response params normalization
 * - built-in token management
 * - error handling
 *
 * @author dragon-fish <dragon-fish@qq.com>
 * @license MIT
 *
 * @param {string|URL} payload create a new FexiosSaikou instance with the given baseURL
 * @param {Fexios} payload or make the given Fexios instance a FexiosSaikou instance
 */
export function createFexiosSaikou(
  payload: string | URL | Fexios
): FexiosSaikou {
  const instance = (
    payload instanceof Fexios
      ? payload
      : new Fexios({
          baseURL:
            payload instanceof URL ? payload.toString() : String(payload),
          responseType: 'json',
        })
  ) as FexiosSaikou

  if ((instance as any)[FEXIOS_SAIKOU_MARKER]) {
    return instance
  } else {
    Reflect.defineProperty(instance, FEXIOS_SAIKOU_MARKER, {
      get: () => true,
      enumerable: false,
      configurable: false,
    })
  }

  // Token handler
  instance._tokens = new Map<MwTokenName, string>()
  instance.on('afterResponse', (ctx) => {
    const { data } = ctx
    // Remove bad token
    const tokenName = ctx.customEnv?.mwTokenName as MwTokenName
    if (tokenName && WikiSaikouError.isBadTokenError(data)) {
      instance._tokens.delete(tokenName)
    }

    // Store new tokens
    const tokens = data?.query?.tokens
    if (tokens && typeof tokens === 'object') {
      Object.entries(tokens).forEach(([type, token]) => {
        typeof token === 'string' &&
          instance._tokens.set(type.replace(/token$/i, '').toLowerCase(), token)
      })
    }
    const loginToken = data?.login?.token
    if (typeof loginToken === 'string') {
      instance._tokens.set('login', loginToken)
    }
    return ctx
  })

  // Adjust request body for POST requests
  instance.on('beforeInit', (ctx) => {
    if (ctx.method?.toLowerCase() !== 'post') {
      return ctx
    }

    if (ctx.body === void 0 || ctx.body === null) {
      ctx.body = void 0
      return ctx
    }

    const body = (ctx.body = MwParamNormalizer.normalizeBody(ctx.body)!)

    // Remove duplicate params: prefer body over query for these keys
    const query = new URLSearchParams(ctx.query as any)
    if (body.has('format')) {
      query.delete('format')
    }
    if (body.has('formatversion')) {
      query.delete('formatversion')
    }
    if (body.has('action')) {
      query.delete('action')
    }
    // `origin` must be in query due to CORS requirements
    if (body.has('origin')) {
      query.set('origin', '' + body.get('origin'))
      body.delete('origin')
    }
    ctx.query = Object.fromEntries(query.entries())

    return ctx
  })

  // Normalize query into FormData-like object
  instance.on('beforeInit', (ctx) => {
    ctx.query = MwParamNormalizer.normalizeBody(ctx.query) || {}
    return ctx
  })

  // Adjust origin parameter and CORS related runtime configs
  instance.on('beforeRequest', (ctx) => {
    const url = new URL(ctx.url!)
    const searchParams = url.searchParams
    // Automatically add/remove origin based on current location and baseURL
    if (globalThis.location) {
      if (!searchParams.has('origin') && location.origin !== url.origin) {
        searchParams.set('origin', location.origin)
        instance.baseConfigs.credentials = 'include'
        instance.baseConfigs.mode = 'cors'
      } else if (location.origin === url.origin) {
        searchParams.delete('origin')
        instance.baseConfigs.credentials = undefined
        instance.baseConfigs.mode = undefined
      }
    }

    if (url.searchParams.has('origin')) {
      const origin = encodeURIComponent(
        url.searchParams.get('origin') || ''
      ).replace(/\./g, '%2E')
      ctx.query = {}
      url.searchParams.delete('origin')
      ctx.url = `${url}${url.search ? '&' : '?'}origin=${origin}`
    }
    return ctx
  })

  return instance
}
