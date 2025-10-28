export type MwApiParams = Record<
  string,
  string | number | string[] | undefined | boolean | File | Blob
>
export type MwTokenName =
  | 'createaccount'
  | 'csrf'
  | 'login'
  | 'patrol'
  | 'rollback'
  | 'userrights'
  | 'watch'
export type MwApiResponse<T = any> = T & {
  batchcomplete?: string
  continue?: {
    [key: string]: string
    continue: string
  }
  limits?: Record<string, number>
  error?: MwApiResponseError
  errors?: MwApiResponseError[]
  warnings?: Record<string, { warnings: string }>
}
export interface MwApiResponseError {
  code: string
  text: string
  module?: string
  docref?: string
}
