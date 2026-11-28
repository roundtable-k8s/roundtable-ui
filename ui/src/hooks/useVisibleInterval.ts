import { useEffect, useRef } from 'react'
import { jitter, nextDelay, retryAfterOf, shouldBackOff } from '../lib/backoff'

export interface VisibleIntervalOptions {
  /** Also run once on mount (when the tab is visible). Default false. */
  immediate?: boolean
  /** Restart the timer (aborting the pending call and running again if `immediate`) when this changes. */
  key?: unknown
}

/**
 * Run `fn` every `ms` while the tab is visible and `enabled`.
 * - Nothing runs while `document.hidden`; on becoming visible `fn` runs once and the timer restarts.
 * - The next tick is scheduled once the previous call (a returned promise) has settled, so ticks never overlap.
 * - `fn` receives an AbortSignal, aborted on unmount, on `key`/`ms`/`enabled` change and when the tab hides.
 * - Back-off (#628): when `fn` throws, rejects or resolves with an error carrying `retryAfterMs` or a
 *   status of 429, >= 500 or 0, the next tick waits twice the interval per consecutive failure (at most
 *   5 x the interval or 60 s, the lower) and at least `retryAfterMs`. The first success resets it.
 * - The first wait after starting (mount or the tab showing again; `fn` itself runs at once then) gets +-10 % jitter.
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
    let timer: ReturnType<typeof setTimeout> | null = null
    let ctrl: AbortController | null = null
    let failures = 0
    let running = false
    let fresh = true // no wait scheduled yet since start: the first one is jittered

    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer)
      fresh = false
      timer = setTimeout(tick, delay)
    }
    const settle = (c: AbortController, outcome: unknown, threw: boolean) => {
      if (ctrl !== c) return // stopped or restarted meanwhile
      running = false
      if (threw || outcome != null) {
        if (shouldBackOff(outcome)) failures++
        else failures = 0
      } else failures = 0
      const wait = nextDelay(ms, failures, retryAfterOf(outcome))
      schedule(fresh && failures === 0 ? jitter(wait) : wait)
    }

    function tick() {
      timer = null
      if (running) return
      const c = ctrl ?? (ctrl = new AbortController())
      let r: void | Promise<unknown>
      try {
        r = fnRef.current(c.signal)
      } catch (e) {
        settle(c, e, true)
        return
      }
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        running = true
        ;(r as Promise<unknown>).then((v) => settle(c, v, false), (e) => settle(c, e, true))
      } else {
        settle(c, undefined, false)
      }
    }
    const stop = () => {
      if (timer) { clearTimeout(timer); timer = null }
      ctrl?.abort()
      ctrl = null
      running = false
      failures = 0
      fresh = true
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else { stop(); tick() }
    }

    if (!document.hidden) {
      if (immediate) tick()
      else schedule(jitter(ms))
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [ms, enabled, immediate, key])
}
