export const deepMerge = <T extends object>(
  obj: T,
  ...incomes: Partial<T>[]
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
    if (inc == null) continue
    for (const key of Reflect.ownKeys(inc)) {
      const nextVal = (inc as any)[key]
      const prevVal = result[key]

      if (isPlainObject(prevVal) && isPlainObject(nextVal)) {
        // 双方都是普通对象 -> 递归合并
        result[key] = deepMerge(prevVal, nextVal)
      } else {
        // 包含数组/基础类型/特殊对象(Date/Map/Set/RegExp等) -> 整体替换
        result[key] = clone(nextVal)
      }
    }
  }

  return result as T
}
