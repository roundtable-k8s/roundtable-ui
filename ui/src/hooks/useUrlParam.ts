import { useCallback, useMemo } from 'react'
import { useUrlParams } from './useUrlParams'

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
  const defaults = useMemo(() => ({ [name]: defaultValue }), [name, defaultValue])
  const allow = useMemo(() => (allowed ? { [name]: allowed } : undefined), [name, allowed])
  const [values, setValues] = useUrlParams(defaults, allow)
  const set = useCallback((next: string) => setValues({ [name]: next }), [setValues, name])
  return [values[name], set]
}
