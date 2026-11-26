import type { FexiosConfigs } from 'fexios'
import {
  WikiSaikouCore,
  type WikiSaikouConfig,
  type WikiSaikouInitConfig,
} from '../WikiSaikou.js'
import { inferMediaWikiEndpoint } from '../internals/params.js'
import { deepMerge } from './deepMerge.js'
import type { MwApiParams } from '../types.js'

export const resolveLegacyCtor = (
  configOrBaseURL?: WikiSaikouInitConfig | string,
  defaultOptions?: Partial<FexiosConfigs>,
  defaultParams?: MwApiParams
): WikiSaikouConfig => {
  let config: WikiSaikouConfig = { ...WikiSaikouCore.DEFAULT_CONFIGS }

  if (typeof configOrBaseURL === 'string') {
    config = deepMerge(config, {
      baseURL: configOrBaseURL,
      fexiosConfigs: defaultOptions || {},
      defaultParams: defaultParams || {},
      throwOnApiError: false,
      restApiEndpoint: undefined,
    })
  } else if (typeof configOrBaseURL === 'object' && configOrBaseURL !== null) {
    config = deepMerge(config, configOrBaseURL)
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
