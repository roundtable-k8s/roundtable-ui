import { useUrlParam } from './useUrlParam'

/** The search parameter that carries the selected RoundTable. */
export const TABLE_PARAM = 'table'

/**
 * The RoundTable every list page is narrowed to, kept in the URL (?table=).
 * '' means all tables. Other search parameters are preserved.
 */
export function useTableFilter() {
  const [table, setTable] = useUrlParam(TABLE_PARAM, '')
  return { table, setTable }
}
