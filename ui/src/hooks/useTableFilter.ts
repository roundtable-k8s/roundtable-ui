import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/** The search parameter that carries the selected RoundTable. */
export const TABLE_PARAM = 'table'

/**
 * The RoundTable every list page is narrowed to, kept in the URL (?table=).
 * '' means all tables. Other search parameters are preserved.
 */
export function useTableFilter() {
  const [params, setParams] = useSearchParams()
  const table = params.get(TABLE_PARAM) ?? ''
  const setTable = useCallback((next: string) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set(TABLE_PARAM, next)
      else p.delete(TABLE_PARAM)
      return p
    }, { replace: true })
  }, [setParams])
  return { table, setTable }
}
