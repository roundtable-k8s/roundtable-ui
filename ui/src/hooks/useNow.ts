import { useState } from 'react'
import { useVisibleInterval } from './useVisibleInterval'

/** Current time in ms, re-rendering every `intervalMs` while the tab is visible. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useVisibleInterval(() => setNow(Date.now()), intervalMs)
  return now
}
