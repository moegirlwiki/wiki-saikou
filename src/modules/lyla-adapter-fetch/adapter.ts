import type {
  LylaAdapter,
  LylaAdapterMeta as LylaCoreAdapterMeta,
} from '@lylajs/core'

export interface LylaAdapterMeta<T = any> extends LylaCoreAdapterMeta {
  method:
    | 'get'
    | 'GET'
    | 'post'
    | 'POST'
    | 'put'
    | 'PUT'
    | 'patch'
    | 'PATCH'
    | 'head'
    | 'HEAD'
    | 'delete'
    | 'DELETE'
    | 'options'
    | 'OPTIONS'
    | 'connect'
    | 'CONNECT'
    | 'trace'
    | 'TRACE'
  networkErrorDetail: TypeError
  requestBody: string | FormData
  responseDetail: Response
  responseType: 'arraybuffer' | 'blob' | 'text'
  responseBody: T
  body: BodyInit
}

function transformHeaders(headers: Headers): Record<string, string> {
  if (!headers) return {}

  const headerMap: Record<string, string> = {}
  headers.forEach((value, key) => {
    headerMap[key] = value
  })

  return headerMap
}

export const adapter: LylaAdapter<LylaAdapterMeta> = ({
  url,
  method,
  headers,
  body,
  responseType,
  withCredentials,
  onDownloadProgress,
  onUploadProgress,
  onResponse,
  onNetworkError,
}): {
  abort: () => void
} => {
  const abortController = new AbortController()
  const request = fetch(url, {
    method,
    headers,
    body,
    credentials: withCredentials ? 'include' : 'same-origin',
    signal: abortController.signal,
  })

  request.then(async (response) => {
    let body: any
    if (responseType === 'blob') {
      try {
        body = await response.clone().blob()
      } catch (error) {}
    } else if (responseType === 'arraybuffer') {
      try {
        body = await response.clone().arrayBuffer()
      } catch (error) {}
    }
    if (!body) {
      body = await response
        .clone()
        .json()
        .catch(() => response.clone().text())
    }

    onResponse(
      {
        status: response.status,
        headers: transformHeaders(response.headers),
        body,
      },
      response
    )
  })

  request.catch((error) => {
    onNetworkError(error)
  })

  return {
    abort() {
      abortController.abort()
    },
  }
}
