import type { FexiosFinalContext } from 'fexios'
import type { FexiosSaikou } from '../models/FexiosSaikou.js'
import { SKIP_TOKEN_STORE } from '../models/FexiosSaikou.js'
import type { MwApiResponse, MwTokenName } from '../types.js'
import { createAbortError, raceWithSignal } from './abort.js'

type TaggedRuntime = Record<PropertyKey, unknown>

/**
 * Manages singleflight token fetching and baseURL-epoch isolation so concurrent
 * `getToken()` calls share one network request without cross-endpoint pollution.
 */
export class TokenManager {
  private inflight = new Map<MwTokenName, Promise<string>>()
  private inflightForced = new Map<MwTokenName, Promise<string>>()
  private baseUrlEpoch = 0
  private requestEpochs = new WeakMap<object, number>()

  constructor(private readonly request: FexiosSaikou) {
    this.request.on(
      'beforeRequest',
      (ctx) => {
        this.requestEpochs.set(ctx.runtime, this.baseUrlEpoch)
        return ctx
      },
      true
    )
    this.request.on(
      'afterResponse',
      (ctx) => {
        const reqEpoch = this.requestEpochs.get(ctx.runtime)
        if (typeof reqEpoch === 'number' && reqEpoch !== this.baseUrlEpoch) {
          ;(ctx.runtime as unknown as TaggedRuntime)[SKIP_TOKEN_STORE] = true
        }
        return ctx
      },
      true
    )
  }

  get cache() {
    return this.request._tokens
  }

  clearInflight(): void {
    this.inflight.clear()
    this.inflightForced.clear()
  }

  onBaseURLChange(): void {
    this.baseUrlEpoch++
    this.clearInflight()
    this.cache.clear()
  }

  async getToken(
    type: MwTokenName,
    noCache: boolean,
    signal: AbortSignal | undefined,
    fetchTokenResponse: (
      type: MwTokenName
    ) => Promise<
      FexiosFinalContext<MwApiResponse<{ query: { tokens: Record<MwTokenName, string> } }>>
    >
  ): Promise<string> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal))
    }

    if (!noCache) {
      const cached = this.cache.get(type)
      if (cached) return cached

      const shared = this.inflight.get(type) ?? this.inflightForced.get(type)
      if (shared) return raceWithSignal(shared, signal)
    } else {
      const sharedForced = this.inflightForced.get(type)
      if (sharedForced) return raceWithSignal(sharedForced, signal)
      this.cache.delete(type)
    }

    const map = noCache ? this.inflightForced : this.inflight
    const pending = fetchTokenResponse(type)
      .then((res) => {
        const tokens = res?.data?.query?.tokens
        if (tokens && typeof tokens === 'object') {
          const matched = Object.entries(tokens).find(
            ([k]) => k.replace(/token$/i, '').toLowerCase() === type
          )
          if (typeof matched?.[1] === 'string') {
            return matched[1]
          }
        }
        return this.cache.get(type)!
      })
      .finally(() => {
        if (map.get(type) === pending) {
          map.delete(type)
        }
      })

    map.set(type, pending)
    return raceWithSignal(pending, signal)
  }
}
