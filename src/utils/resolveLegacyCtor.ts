import { WikiSaikou, MwApiParams, WikiSaikouConfig } from '../WikiSaikou.js'
import { FexiosConfigs } from 'fexios'
import { deepMerge } from './deepMerge.js'

export const resolveLegacyCtor = (
  configOrBaseURL?: WikiSaikouConfig | string,
  defaultOptions?: Partial<FexiosConfigs>,
  defaultParams?: MwApiParams
) => {
  let config: Required<WikiSaikouConfig> = { ...WikiSaikou.DEFAULT_CONFIGS }
  if (typeof configOrBaseURL === 'string') {
    config = deepMerge(config, {
      baseURL: configOrBaseURL,
      defaultOptions: defaultOptions || {},
      defaultParams: defaultParams || {},
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
    }
  }
  if (typeof config.baseURL !== 'string') {
    throw new Error('baseURL is required')
  }
  return config
}
