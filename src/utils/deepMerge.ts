export const deepMerge = <T extends object>(
  obj: T,
  ...incomes: (Partial<T> | null | undefined)[]
): T => {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    Object.prototype.toString.call(v) === '[object Object]'

  const clone = (v: any): any => {
    if (Array.isArray(v)) return v.slice()
    if (isPlainObject(v)) {
      const out: Record<PropertyKey, any> = {}
      for (const k of Reflect.ownKeys(v)) out[k] = clone((v as any)[k])
      return out
    }
    return v
  }

  const result: Record<PropertyKey, any> = clone(obj)

  for (const inc of incomes) {
    if (inc === null || inc === void 0) continue
    for (const key of Reflect.ownKeys(inc)) {
      const nextVal = (inc as any)[key]
      if (typeof nextVal === 'undefined') continue
      const prevVal = result[key]
      if (isPlainObject(prevVal) && isPlainObject(nextVal)) {
        result[key] = deepMerge(prevVal, nextVal)
      } else {
        result[key] = clone(nextVal)
      }
    }
  }

  return result as T
}
