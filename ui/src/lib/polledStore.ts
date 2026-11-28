import { apiGet } from './api'

/** An entry is dropped this long after its last subscriber leaves. */
export const GRACE_MS = 30_000

export interface PolledSnapshot {
  data: unknown
  hasData: boolean
  error: string | null
  errorStatus?: number
  loading: boolean
  updatedAt: number | null
}

const EMPTY: PolledSnapshot = { data: undefined, hasData: false, error: null, loading: true, updatedAt: null }

interface Entry {
  url: string
  snap: PolledSnapshot
  /** Requested interval of each subscriber (<= 0 = one-shot). */
  subs: Map<symbol, number>
  /** Callers of fetchFresh() still waiting; they keep the request alive without polling. */
  waiters: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | null
  timerMs: number
  ctrl: AbortController | null
  inflight: Promise<void> | null
  /** A forced refresh waiting for the running request to finish. */
  queued: Promise<void> | null
  drop: ReturnType<typeof setTimeout> | null
}

const entries = new Map<string, Entry>()

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

function set(en: Entry, patch: Partial<PolledSnapshot>) {
  en.snap = { ...en.snap, ...patch }
  en.listeners.forEach((l) => l())
}

function load(en: Entry): Promise<void> {
  if (en.inflight) return en.inflight
  const ctrl = new AbortController()
  en.ctrl = ctrl
  const p = Promise.resolve(apiGet<unknown>(en.url, { signal: ctrl.signal })).then(
    (data) => {
      if (ctrl.signal.aborted) return
      set(en, { data, hasData: true, error: null, errorStatus: undefined, loading: false, updatedAt: Date.now() })
    },
    (e) => {
      if (ctrl.signal.aborted) return
      set(en, { error: e instanceof Error ? e.message : 'Unknown error', errorStatus: statusOf(e), loading: false })
    },
  ).finally(() => {
    if (en.ctrl === ctrl) { en.ctrl = null; en.inflight = null }
  })
  en.inflight = p
  return p
}

function abort(en: Entry) {
  en.ctrl?.abort()
  en.ctrl = null
  en.inflight = null
}

/** The smallest positive interval among the subscribers, 0 when none polls. */
function wantedMs(en: Entry): number {
  let ms = 0
  for (const v of en.subs.values()) if (v > 0 && (ms === 0 || v < ms)) ms = v
  return ms
}

function syncTimer(en: Entry) {
  const ms = document.hidden ? 0 : wantedMs(en)
  if (ms === en.timerMs) return
  if (en.timer) clearInterval(en.timer)
  en.timer = ms > 0 ? setInterval(() => { void load(en) }, ms) : null
  en.timerMs = ms
}

function scheduleDrop(en: Entry) {
  if (en.subs.size > 0 || en.drop) return
  en.drop = setTimeout(() => {
    if (en.subs.size === 0 && entries.get(en.url) === en) entries.delete(en.url)
  }, GRACE_MS)
}

function entryFor(url: string): Entry {
  let en = entries.get(url)
  if (!en) {
    en = { url, snap: EMPTY, subs: new Map(), waiters: 0, listeners: new Set(), timer: null, timerMs: 0, ctrl: null, inflight: null, queued: null, drop: null }
    entries.set(url, en)
  }
  if (en.drop) { clearTimeout(en.drop); en.drop = null }
  return en
}

/**
 * Subscribe to `url`, polled every `intervalMs` (<= 0: fetched once by the first subscriber).
 * The first subscriber starts the fetch, later ones share its result; one request is in
 * flight per url, at the smallest interval any subscriber asked for. Returns the unsubscribe.
 */
export function subscribe(url: string, intervalMs: number, listener: () => void): () => void {
  const en = entryFor(url)
  const id = Symbol()
  const first = en.subs.size === 0
  en.subs.set(id, intervalMs)
  en.listeners.add(listener)
  if (first) {
    // A fresh entry loads; one revived from the grace period reloads too unless a request is running.
    if (intervalMs <= 0 || !document.hidden) void load(en)
  }
  syncTimer(en)
  return () => {
    en.subs.delete(id)
    en.listeners.delete(listener)
    syncTimer(en)
    if (en.subs.size === 0) {
      if (en.waiters === 0) abort(en)
      scheduleDrop(en)
    }
  }
}

export function getSnapshot(url: string): PolledSnapshot {
  return entries.get(url)?.snap ?? EMPTY
}

/**
 * Force a fetch that starts now. A request already running may predate the change the caller
 * just made, so it is not reused: the new fetch starts when it ends, and callers refreshing
 * meanwhile share that one.
 */
export function refresh(url: string): Promise<void> {
  const en = entries.get(url)
  if (!en) return Promise.resolve()
  if (!en.inflight) return load(en)
  if (!en.queued) {
    const q: Promise<void> = en.inflight.then(() => { en.queued = null; return load(en) })
    en.queued = q
  }
  return en.queued
}

/**
 * The data of `url` when fetched less than `maxAgeMs` ago, else a (shared) fetch of it.
 * Rejects when the last fetch failed or there is no data.
 */
export async function fetchFresh<T>(url: string, maxAgeMs: number): Promise<T> {
  const en = entryFor(url)
  const fresh = (s: PolledSnapshot) => s.hasData && s.updatedAt !== null && Date.now() - s.updatedAt < maxAgeMs
  try {
    if (!fresh(en.snap)) {
      en.waiters++
      try { await load(en) } finally { en.waiters-- }
    }
    if (!en.snap.hasData || en.snap.error) throw new Error(en.snap.error ?? 'no data')
    return en.snap.data as T
  } finally {
    scheduleDrop(en)
  }
}

document.addEventListener('visibilitychange', () => {
  for (const en of entries.values()) {
    if (document.hidden) {
      // One-shot requests and fetchFresh() waiters are not tied to the poll, so they run on:
      // nothing would reload them when the tab shows again.
      if (wantedMs(en) > 0 && en.waiters === 0) abort(en)
      syncTimer(en)
    } else if (en.subs.size > 0) {
      syncTimer(en)
      if (wantedMs(en) > 0) void load(en)
    }
  }
})

/** Test helper: forget every entry and stop their timers. */
export function resetPolledStore() {
  for (const en of entries.values()) {
    abort(en)
    if (en.timer) clearInterval(en.timer)
    if (en.drop) clearTimeout(en.drop)
  }
  entries.clear()
}
