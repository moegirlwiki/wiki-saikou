import { Fexios, type FexiosConfigs, FexiosQueryBuilder } from 'fexios'
import { MwParamNormalizer } from './MwParamNormalizer.js'
import { WikiSaikouError } from './errors.js'
import type { MwTokenName } from '../types.js'

export interface FexiosSaikou extends Fexios {
  _tokens: Map<string, string>
}

export type FexiosSaikouInitConfig = Omit<Partial<FexiosConfigs>, 'baseURL'> & {
  baseURL?: string | URL
}

export const isUrlLike = (value: unknown): value is URL =>
  value instanceof URL ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as { href?: unknown }).href === 'string' &&
    Object.prototype.toString.call(value) === '[object URL]')

export const normalizeHeadersInit = (
  headers?: FexiosConfigs['headers']
): Record<string, string> | undefined => {
  if (!headers) return undefined
  if (
    (typeof Headers !== 'undefined' && headers instanceof Headers) ||
    (typeof headers === 'object' &&
      typeof (headers as Headers).forEach === 'function' &&
      typeof (headers as Headers).get === 'function')
  ) {
    const record: Record<string, string> = {}
    ;(headers as Headers).forEach((value, key) => {
      record[key] = value
    })
    return record
  }
  if (Array.isArray(headers)) {
    const record: Record<string, string> = {}
    const keyByLower = new Map<string, string>()
    for (const [rawKey, rawValue] of headers) {
      const key = String(rawKey)
      const lower = key.toLowerCase()
      const existingKey = keyByLower.get(lower)
      if (existingKey !== undefined) {
        record[existingKey] = `${record[existingKey]}, ${String(rawValue)}`
      } else {
        keyByLower.set(lower, key)
        record[key] = String(rawValue)
      }
    }
    return record
  }
  return headers as Record<string, string>
}

const FEXIOS_SAIKOU_MARKER = Symbol.for('__FEXIOS_SAIKOU__')
export const SKIP_TOKEN_STORE = Symbol.for('__WIKI_SAIKOU_SKIP_TOKEN_STORE__')

type TaggedObject = Record<PropertyKey, unknown>

const BODY_PREFERRED_QUERY_KEYS = ['format', 'formatversion', 'action'] as const

/**
 * FexiosSaikou
 *
 * A pre-configured Fexios instance with MediaWiki-friendly defaults:
 * - MediaWiki-specific request/response params normalization
 * - built-in token management
 * - CORS origin handling
 *
 * @param {string|URL|Fexios|FexiosSaikouInitConfig} payload create a new FexiosSaikou instance with the given baseURL or Fexios configs, or make the given Fexios instance a FexiosSaikou instance
 */
export function createFexiosSaikou(
  payload: string | URL | Fexios | FexiosSaikouInitConfig
): FexiosSaikou {
  const instance = (
    payload instanceof Fexios
      ? payload
      : typeof payload === 'string' || isUrlLike(payload)
        ? new Fexios({
            baseURL: isUrlLike(payload) ? payload.toString() : String(payload),
            responseType: 'json',
          })
        : (() => {
            const { baseURL, headers, ...rest } = payload
            const normalizedHeaders = normalizeHeadersInit(headers)
            return new Fexios({
              responseType: 'json',
              ...rest,
              ...(baseURL !== undefined
                ? {
                    baseURL: isUrlLike(baseURL) ? baseURL.toString() : baseURL,
                  }
                : {}),
              ...(normalizedHeaders !== undefined
                ? { headers: normalizedHeaders }
                : {}),
            })
          })()
  ) as FexiosSaikou

  if ((instance as unknown as TaggedObject)[FEXIOS_SAIKOU_MARKER]) {
    return instance
  }
  Reflect.defineProperty(instance, FEXIOS_SAIKOU_MARKER, {
    get: () => true,
    enumerable: false,
    configurable: false,
  })

  // Normalize POST body and query parameters into MediaWiki-friendly formats
  instance.on('beforeInit', (ctx) => {
    if (ctx.request.method?.toLowerCase() === 'post') {
      if (ctx.request.body === undefined || ctx.request.body === null) {
        ctx.request.body = undefined
      } else {
        const body = MwParamNormalizer.normalizeBody(ctx.request.body)!
        ctx.request.body = body

        const query = FexiosQueryBuilder.makeSearchParams(
          ctx.request.query as Record<string, unknown> | URLSearchParams
        )
        // Prefer body over query for shared MediaWiki envelope keys
        for (const key of BODY_PREFERRED_QUERY_KEYS) {
          if (body.has(key)) query.delete(key)
        }
        // `origin` must be in query due to CORS requirements
        if (body.has('origin')) {
          query.set('origin', String(body.get('origin')))
          body.delete('origin')
        }
        ctx.request.query = Object.fromEntries(query.entries())
      }
    }

    ctx.request.query = FexiosQueryBuilder.mergeQueries(
      {},
      MwParamNormalizer.normalizeBody(ctx.request.query)
    )
    return ctx
  })

  // Adjust `origin` parameter and per-request CORS settings
  instance.on('beforeRequest', (ctx) => {
    const url = new URL(ctx.request.url)
    const query = FexiosQueryBuilder.mergeQueries(url.searchParams, ctx.query)

    if (globalThis.location) {
      if (!query.origin && location.origin !== url.origin) {
        query.origin = location.origin
        ctx.request.credentials ??= 'include'
        ctx.request.mode ??= 'cors'
      } else if (location.origin === url.origin) {
        delete query.origin
      }
    }

    if (query.origin) {
      const origin = encodeURIComponent(query.origin).replace(/\./g, '%2E')
      delete query.origin
      ctx.request.query = query
      // Append origin directly with strict dot-encoding expected by MediaWiki
      ctx.request.url = `${url.origin}${url.pathname}?origin=${origin}`
    } else {
      ctx.request.query = query
    }
    return ctx
  })

  // Cache returned tokens and evict stale tokens on badtoken errors
  instance._tokens = new Map<MwTokenName, string>()
  instance.on('afterResponse', (ctx) => {
    if ((ctx.runtime as unknown as TaggedObject)?.[SKIP_TOKEN_STORE]) {
      return ctx
    }
    const { data } = ctx
    const tokenName = ctx.runtime.customEnv?.mwTokenName as
      | MwTokenName
      | undefined
    if (tokenName && WikiSaikouError.isBadTokenError(data)) {
      instance._tokens.delete(tokenName)
    }

    const tokens = data?.query?.tokens
    if (tokens && typeof tokens === 'object') {
      for (const [type, token] of Object.entries(tokens)) {
        if (typeof token === 'string') {
          instance._tokens.set(type.replace(/token$/i, '').toLowerCase(), token)
        }
      }
    }
    const loginToken = data?.login?.token
    if (typeof loginToken === 'string') {
      instance._tokens.set('login', loginToken)
    }
    return ctx
  })

  return instance
}
