import { isPlainObject } from 'fexios'

const isFormLike = (body: unknown): body is URLSearchParams | FormData =>
  Boolean(
    body &&
      (body instanceof URLSearchParams ||
        (typeof FormData !== 'undefined' && body instanceof FormData))
  )

export namespace MwParamNormalizer {
  export function normalizeParamValue(item: unknown): string | Blob | undefined {
    if (Array.isArray(item)) return item.join('|')
    if (typeof item === 'boolean' || item === null) return item ? '1' : undefined
    if (typeof item === 'number') return String(item)
    return item as string | Blob | undefined
  }

  export function normalizeBody(body: unknown): FormData | undefined {
    if (body === undefined || body === null) return undefined

    const formData = new FormData()
    const appendNormalized = (value: unknown, key: string) => {
      const normalized = normalizeParamValue(value)
      if (normalized !== undefined && normalized !== null) {
        formData.append(key, normalized)
      }
    }

    if (isFormLike(body)) {
      body.forEach(appendNormalized)
      return formData
    }

    if (isPlainObject(body)) {
      for (const [key, value] of Object.entries(body)) {
        appendNormalized(value, key)
      }
      return formData
    }

    return undefined
  }
}
