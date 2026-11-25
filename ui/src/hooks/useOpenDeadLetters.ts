import { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'
import { DEAD_LETTERS_URL, type DeadLetter } from '../lib/deadLetters'

/** Number of open dead letters, polled for the nav badge. 0 when the gateway is not configured or unreachable. */
export function useOpenDeadLetters(intervalMs = 60000): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const poll = () =>
      apiGet<{ deadLetters?: DeadLetter[] }>(`${DEAD_LETTERS_URL}?state=open`)
        .then((d) => { if (alive) setCount(d.deadLetters?.length ?? 0) })
        .catch(() => { if (alive) setCount(0) })
    poll()
    const id = setInterval(poll, intervalMs)
    return () => { alive = false; clearInterval(id) }
  }, [intervalMs])
  return count
}
