import { useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'

export type UrlParamPatch<K extends string> = Partial<Record<K, string | null>>

/**
 * Several filters kept in the URL (?a=1&b=2). A value outside `allowed` reads as
 * the default. A patch value equal to the default, '' or null removes the param;
 * one patch is one `setParams` call (one history entry, `replace`), and search
 * params that are not listed in `defaults` are preserved.
 */
export function useUrlParams<K extends string>(
  defaults: Record<K, string>,
  allowed?: Partial<Record<K, readonly string[]>>,
): [Record<K, string>, (patch: UrlParamPatch<K>) => void] {
  const [params, setParams] = useSearchParams()
  const keys = Object.keys(defaults) as K[]
  const values = {} as Record<K, string>
  for (const k of keys) {
    const raw = params.get(k)
    const list = allowed?.[k]
    values[k] = raw === null || (list && !list.includes(raw)) ? defaults[k] : raw
  }
  // Callers may pass fresh objects each render; keep the setter stable.
  const latest = useRef(defaults)
  latest.current = defaults
  const set = useCallback((patch: UrlParamPatch<K>) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch) as [K, string | null | undefined][]) {
        if (v === undefined) continue
        if (v === null || v === '' || v === latest.current[k]) p.delete(k)
        else p.set(k, v)
      }
      return p
    }, { replace: true })
  }, [setParams])
  return [values, set]
}
