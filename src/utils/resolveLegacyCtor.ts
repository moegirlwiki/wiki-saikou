import type { FexiosConfigs } from 'fexios'
import {
  WikiSaikouCore,
  type WikiSaikouConfig,
  type WikiSaikouInitConfig,
} from '../WikiSaikou.js'
import { inferMediaWikiEndpoint } from '../internals/params.js'
import { normalizeHeadersInit } from '../models/FexiosSaikou.js'
import { deepMerge } from './deepMerge.js'
import type { MwApiParams } from '../types.js'

const normalizeFexiosHeadersOption = (
  options?: Partial<FexiosConfigs>
): Partial<FexiosConfigs> | undefined => {
  if (!options?.headers) return options
  const normalized = normalizeHeadersInit(options.headers)
  return normalized === options.headers
    ? options
    : { ...options, headers: normalized }
}

export const resolveLegacyCtor = (
  configOrBaseURL?: WikiSaikouInitConfig | string,
  defaultOptions?: Partial<FexiosConfigs>,
  defaultParams?: MwApiParams
): WikiSaikouConfig => {
  let config: WikiSaikouConfig = { ...WikiSaikouCore.DEFAULT_CONFIGS }

  if (typeof configOrBaseURL === 'string') {
    config = deepMerge(config, {
      baseURL: configOrBaseURL,
      fexiosConfigs: normalizeFexiosHeadersOption(defaultOptions) || {},
      defaultParams: defaultParams || {},
      throwOnApiError: false,
      restApiEndpoint: undefined,
    })
  } else if (typeof configOrBaseURL === 'object' && configOrBaseURL !== null) {
    const normalizedConfig = configOrBaseURL.fexiosConfigs
      ? {
          ...configOrBaseURL,
          fexiosConfigs: normalizeFexiosHeadersOption(
            configOrBaseURL.fexiosConfigs
          ),
        }
      : configOrBaseURL
    config = deepMerge(config, normalizedConfig)
  }

  if (!config.baseURL) {
    const inferred = inferMediaWikiEndpoint('api.php')
    if (inferred) config.baseURL = inferred
  }

  if (typeof config.baseURL !== 'string') {
    throw new Error('baseURL is required')
  }
  return config
}
