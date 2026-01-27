import type { FexiosConfigs } from 'fexios'
import {
  WikiSaikouCore,
  WikiSaikouConfig,
  WikiSaikouInitConfig,
} from '../WikiSaikou.js'
import { deepMerge } from '../utils/deepMerge.js'
import { MwApiParams } from '../types.js'

export const resolveLegacyCtor = (
  configOrBaseURL?: WikiSaikouInitConfig | string,
  defaultOptions?: Partial<FexiosConfigs>,
  defaultParams?: MwApiParams
) => {
  let config: Required<WikiSaikouConfig> = { ...WikiSaikouCore.DEFAULT_CONFIGS }
  if (typeof configOrBaseURL === 'string') {
    config = deepMerge(config, {
      baseURL: configOrBaseURL,
      fexiosConfigs: defaultOptions || {},
      defaultParams: defaultParams || {},
      throwOnApiError: false, // Set a default value for throwOnApiError
      restApiEndpoint: undefined, // Set a default value for restApiEndpoint
    })
  } else if (typeof configOrBaseURL === 'object' && configOrBaseURL !== null) {
    config = deepMerge(config, configOrBaseURL)
  }
  // For MediaWiki browser environment
  if (
    !config.baseURL &&
    typeof window === 'object' &&
    (window as any).mediaWiki
  ) {
    const { wgServer, wgScriptPath } =
      (window as any).mediaWiki?.config?.get(['wgServer', 'wgScriptPath']) || {}
    if (typeof wgServer === 'string' && typeof wgScriptPath === 'string') {
      config.baseURL = `${wgServer}${wgScriptPath}/api.php`
      if (config.baseURL.startsWith('//')) {
        config.baseURL = `${window.location.protocol}${config.baseURL}`
      }
    }
  }
  if (typeof config.baseURL !== 'string') {
    throw new Error('baseURL is required')
  }
  return config
}
