import { Fexios, FexiosQueryBuilder } from 'fexios'
import { MwParamNormalizer } from './MwParamNormalizer.js'
import { WikiSaikouError } from './errors.js'
import type { MwTokenName } from '../types.js'

export interface FexiosSaikou extends Fexios {
  _tokens: Map<string, string>
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
