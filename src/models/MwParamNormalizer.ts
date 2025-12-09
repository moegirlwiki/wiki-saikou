import { isPlainObject } from 'fexios'

export namespace MwParamNormalizer {
  export function normalizeParamValue(item: any): string | Blob | undefined {
    if (Array.isArray(item)) {
      return item.join('|')
    } else if (typeof item === 'boolean' || item === null) {
      return item ? '1' : undefined
    } else if (typeof item === 'number') {
      return '' + item
    } else {
      return item
    }
  }

  export function normalizeBody(body: any): FormData | undefined {
    const isFormLike = (body: any): body is URLSearchParams | FormData =>
      body && (body instanceof URLSearchParams || body instanceof FormData)

    if (body === void 0 || body === null) {
      return void 0
    }

    const formData = new FormData()

    if (isFormLike(body)) {
      body.forEach((value, key) => {
        const data = normalizeParamValue(value)
        if (data !== null && data !== void 0) {
          formData.append(key, data as any)
        }
      })
      return formData
    }

    if (isPlainObject(body)) {
      Object.entries(body).forEach(([key, value]) => {
        const data = normalizeParamValue(value)
        if (data !== null && data !== void 0) {
          formData.append(key, data as any)
        }
      })
      return formData
    }

    return void 0
  }
}
