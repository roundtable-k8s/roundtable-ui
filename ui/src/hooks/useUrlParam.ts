import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * One filter kept in the URL (?name=value). The param is removed when the value
 * equals the default, writes use `replace` and other search params are preserved.
 * When `allowed` is given, a URL value outside it falls back to the default.
 */
export function useUrlParam(
  name: string,
  defaultValue: string,
  allowed?: readonly string[],
): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get(name)
  const value = raw === null || (allowed && !allowed.includes(raw)) ? defaultValue : raw
  const set = useCallback((next: string) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next === defaultValue || next === '') p.delete(name)
      else p.set(name, next)
      return p
    }, { replace: true })
  }, [setParams, name, defaultValue])
  return [value, set]
}
