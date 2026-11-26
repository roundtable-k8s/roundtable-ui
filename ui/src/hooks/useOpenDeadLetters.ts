import { useState } from 'react'
import { useVisibleInterval } from './useVisibleInterval'
import { inTable } from '../lib/tables'
import { apiGet } from '../lib/api'
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
}

/** Open dead letters, polled for the nav badge. `error` is set when the last poll failed (the count is then unknown). */
export function useOpenDeadLetters(table = '', intervalMs = 60000): OpenDeadLetters {
  const [state, setState] = useState<OpenDeadLetters>({ count: 0, capped: false })
  useVisibleInterval(
    (signal) =>
      apiGet<{ deadLetters?: DeadLetter[]; total?: number }>(`${DEAD_LETTERS_URL}?state=open`, { signal })
        .then((d) => {
          const all = d.deadLetters ?? []
          const count = all.filter((x) => inTable(table, x.table)).length
          const capped = all.length >= DEAD_LETTER_CAP || (typeof d.total === 'number' && d.total > all.length)
          setState({ count, capped, total: !table && typeof d.total === 'number' ? d.total : undefined })
        })
        .catch(() => { if (!signal.aborted) setState((prev) => ({ ...prev, error: true })) }),
    intervalMs,
    true,
    { immediate: true, key: table },
  )
  return state
}

/** Badge text and tooltip: "100+" with the real count in the title when known. */
export function deadLetterBadge({ count, capped, total, error }: OpenDeadLetters): { text: string; title: string } {
  if (error) return { text: '?', title: 'dead-letter count unavailable' }
  if (!capped) return { text: String(count), title: `${count} open` }
  const text = `${count}+`
  return { text, title: total !== undefined ? `${total} open (showing ${count}+)` : `${count} or more open — the list is capped, the real number is not reported` }
}
