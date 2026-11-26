import { useEffect, useState } from 'react'
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
}

/** Open dead letters, polled for the nav badge. Zero when the gateway is not configured or unreachable. */
export function useOpenDeadLetters(table = '', intervalMs = 60000): OpenDeadLetters {
  const [state, setState] = useState<OpenDeadLetters>({ count: 0, capped: false })
  useEffect(() => {
    let alive = true
    const poll = () =>
      apiGet<{ deadLetters?: DeadLetter[]; total?: number }>(`${DEAD_LETTERS_URL}?state=open`)
        .then((d) => {
          if (!alive) return
          const all = d.deadLetters ?? []
          const count = all.filter((x) => inTable(table, x.table)).length
          const capped = all.length >= DEAD_LETTER_CAP || (typeof d.total === 'number' && d.total > all.length)
          setState({ count, capped, total: !table && typeof d.total === 'number' ? d.total : undefined })
        })
        .catch(() => { if (alive) setState({ count: 0, capped: false }) })
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [table, intervalMs])
  return state
}

/** Badge text and tooltip: "100+" with the real count in the title when known. */
export function deadLetterBadge({ count, capped, total }: OpenDeadLetters): { text: string; title: string } {
  if (!capped) return { text: String(count), title: `${count} open` }
  const text = `${count}+`
  return { text, title: total !== undefined ? `${total} open (showing ${count}+)` : `${count} or more open — the list is capped, the real number is not reported` }
}
