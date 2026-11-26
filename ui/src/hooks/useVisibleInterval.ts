import { useEffect, useRef } from 'react'

export interface VisibleIntervalOptions {
  /** Also run once on mount (when the tab is visible). Default false. */
  immediate?: boolean
  /** Restart the timer (aborting the pending call and running again if `immediate`) when this changes. */
  key?: unknown
}

/**
 * Run `fn` every `ms` while the tab is visible and `enabled`.
 * - Nothing runs while `document.hidden`; on becoming visible `fn` runs once and the timer restarts.
 * - A tick is skipped while the previous call (a returned promise) is still pending.
 * - `fn` receives an AbortSignal, aborted on unmount, on `key`/`ms`/`enabled` change and when the tab hides.
 */
export function useVisibleInterval(
  fn: (signal: AbortSignal) => void | Promise<unknown>,
  ms: number,
  enabled = true,
  { immediate = false, key }: VisibleIntervalOptions = {},
): void {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setInterval> | null = null
    let ctrl: AbortController | null = null
    let pending = false

    const tick = () => {
      if (pending) return
      const c = ctrl ?? (ctrl = new AbortController())
      let r: void | Promise<unknown>
      try {
        r = fnRef.current(c.signal)
      } catch {
        return
      }
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        pending = true
        const done = () => { if (ctrl === c) pending = false }
        ;(r as Promise<unknown>).then(done, done)
      }
    }
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
      ctrl?.abort()
      ctrl = null
      pending = false
    }
    const start = () => {
      if (!timer) timer = setInterval(tick, ms)
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else { stop(); start(); tick() }
    }

    if (!document.hidden) {
      start()
      if (immediate) tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ms, enabled, immediate, key])
}
