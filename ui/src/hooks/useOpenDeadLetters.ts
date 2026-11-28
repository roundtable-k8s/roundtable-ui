import { useMemo } from 'react'
import { usePolledFetch } from './usePolledFetch'
import { inTable } from '../lib/tables'
import { DEAD_LETTERS_URL, type DeadLetter } from '../lib/deadLetters'

/** The gateway lists at most this many dead letters by default, so a count this high may be cut short. */
export const DEAD_LETTER_CAP = 100

export interface OpenDeadLetters {
  /** Open dead letters seen (capped at DEAD_LETTER_CAP when `capped`). */
  count: number
  /** The list hit the cap: the real number may be higher. */
  capped: boolean
  /** The real number when the gateway reports one (`total`) and no table filter applies. */
  total?: number
  /** The last poll failed: the count is unknown, not zero. */
  error?: boolean
  /** No poll has answered yet: the count is unknown, not zero. */
  loading?: boolean
}

/**
 * Open dead letters, polled for the nav badge. The list is fetched unfiltered and shared by every
 * component using it; the table filter is applied in the browser. `error` is set when the last
 * poll failed (the count is then unknown).
 */
export function useOpenDeadLetters(table = '', intervalMs = 60000): OpenDeadLetters {
  const { data, error, errorStatus, loading } = usePolledFetch<{ deadLetters?: DeadLetter[]; total?: number } | null>(
    `${DEAD_LETTERS_URL}?state=open`, intervalMs, null)
  return useMemo(() => {
    // 503 means the API has no GATEWAY_URL: nothing to count, not a failure (an unreachable gateway is 502).
    if (error && errorStatus === 503) return { count: 0, capped: false, loading: false }
    if (!data) {
      return error ? { count: 0, capped: false, loading: false, error: true } : { count: 0, capped: false, loading }
    }
    const all = data.deadLetters ?? []
    const count = all.filter((x) => inTable(table, x.table)).length
    const capped = all.length >= DEAD_LETTER_CAP || (typeof data.total === 'number' && data.total > all.length)
    const res: OpenDeadLetters = { count, capped, total: !table && typeof data.total === 'number' ? data.total : undefined, loading: false }
    if (error) res.error = true
    return res
  }, [data, error, errorStatus, loading, table])
}

/** Badge text and tooltip: "100+" with the real count in the title when known. */
export function deadLetterBadge({ count, capped, total, error }: OpenDeadLetters): { text: string; title: string } {
  if (error) return { text: '?', title: 'dead-letter count unavailable' }
  if (!capped) return { text: String(count), title: `${count} open` }
  const text = `${count}+`
  return { text, title: total !== undefined ? `${total} open (showing ${count}+)` : `${count} or more open — the list is capped, the real number is not reported` }
}
