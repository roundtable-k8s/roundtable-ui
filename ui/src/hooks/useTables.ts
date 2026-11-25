import { usePolledFetch } from './usePolledFetch'
import type { RoundTable } from '../lib/types'

/** The RoundTables the API knows, for the table selector. */
export function useTables(intervalMs = 30000): string[] {
  const { data } = usePolledFetch<RoundTable[]>('/api/roundtables', intervalMs, [])
  return (Array.isArray(data) ? data : []).map((t) => t.name).sort()
}
