import type { MwApiParams } from '../types.js'

const isFormData = (data: unknown): data is FormData =>
  typeof FormData !== 'undefined' && data instanceof FormData

/** Read a parameter value from URLSearchParams, FormData, or a plain object. */
export function getParam(data: unknown, key: string): unknown {
  if (!data || typeof data !== 'object') return undefined
  if (data instanceof URLSearchParams || isFormData(data)) {
    return data.get(key)
  }
  return (data as Record<string, unknown>)[key]
}

/** Check whether a parameter key is present in URLSearchParams, FormData, or a plain object. */
export function hasParam(data: unknown, key: string): boolean {
  if (!data || typeof data !== 'object') return false
  if (data instanceof URLSearchParams || isFormData(data)) {
    return data.has(key)
  }
  return (data as Record<string, unknown>)[key] !== undefined
}

/** Set a parameter value on URLSearchParams, FormData, or a plain object. */
export function setParam(data: unknown, key: string, value: string): void {
  if (!data || typeof data !== 'object') return
  if (data instanceof URLSearchParams || isFormData(data)) {
    data.set(key, value)
  } else {
    ;(data as Record<string, unknown>)[key] = value
  }
}

/** Normalize a pipe-delimited string or array parameter into a trimmed string array. */
export function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean)
  }
  return String(value)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * Return a shallow copy of a POST body (`FormData`, `URLSearchParams`, or plain
 * object) with the given token field attached, without mutating caller input.
 */
export function cloneBodyWithToken(
  body: MwApiParams | URLSearchParams | FormData,
  tokenName: string,
  token: string
): MwApiParams | URLSearchParams | FormData {
  if (isFormData(body)) {
    const copy = new FormData()
    body.forEach((value, key) => copy.append(key, value))
    copy.set(tokenName, token)
    return copy
  }
  if (body instanceof URLSearchParams) {
    const copy = new URLSearchParams(body)
    copy.set(tokenName, token)
    return copy
  }
  return {
    [tokenName]: token,
    ...body,
  }
}

interface MediaWikiBrowserGlobal {
  mediaWiki?: {
    config?: {
      get?: (keys: string[]) => { wgServer?: unknown; wgScriptPath?: unknown }
    }
  }
  location?: { protocol?: string }
}

/**
 * Infer a MediaWiki endpoint URL (`api.php` or `rest.php/`) from the browser's
 * global `window.mediaWiki.config` when running inside a MediaWiki page.
 */
export function inferMediaWikiEndpoint(
  suffix: 'api.php' | 'rest.php/'
): string | undefined {
  if (typeof window !== 'object' || !window) return undefined
  try {
    const win = window as unknown as MediaWikiBrowserGlobal
    const { wgServer, wgScriptPath } =
      win.mediaWiki?.config?.get?.(['wgServer', 'wgScriptPath']) || {}
    if (typeof wgServer !== 'string' || typeof wgScriptPath !== 'string') {
      return undefined
    }
    const url = `${wgServer}${wgScriptPath}/${suffix}`
    return url.startsWith('//') && win.location?.protocol
      ? `${win.location.protocol}${url}`
      : url
  } catch {
    return undefined
  }
}
