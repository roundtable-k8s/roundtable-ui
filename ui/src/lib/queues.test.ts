import { describe, it, expect } from 'vitest'
import {
  type KnightQueue,
  appendSamples, atMaxReplicas, formatWait, grafanaKnightUrl, oldestWait, queueWarnings, scaleEvents,
  OLDEST_WAIT_WARN_SECONDS,
} from './queues'

const T0 = Date.parse('2026-11-24T12:00:00Z')

export function queue(over: Partial<KnightQueue> = {}): KnightQueue {
  return {
    knight: 'galahad', stream: 'fleet_a_tasks', consumer: 'galahad-consumer', consumerFound: true,
    pending: 0, ackPending: 0, redelivered: 0, waiting: 2, oldestWaitSeconds: 0,
    concurrency: 2, replicas: 1, readyReplicas: 1, freeSlots: 2, ...over,
  }
}

describe('formatWait', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatWait(0)).toBe('—')
    expect(formatWait(42.7)).toBe('42s')
    expect(formatWait(125)).toBe('2m 5s')
    expect(formatWait(7260)).toBe('2h 1m')
  })
})

describe('oldestWait', () => {
  it('keeps growing between polls from oldestPendingAt', () => {
    const q = queue({ oldestPendingAt: new Date(T0).toISOString(), oldestWaitSeconds: 10 })
    expect(oldestWait(q, T0 + 30_000)).toBe(30)
    expect(oldestWait(q, T0 + 90_000)).toBe(90)
  })
  it('falls back to oldestWaitSeconds and is 0 with nothing waiting', () => {
    expect(oldestWait(queue({ oldestWaitSeconds: 12 }), T0)).toBe(12)
    expect(oldestWait(queue(), T0)).toBe(0)
  })
})

describe('queueWarnings', () => {
  it('is empty for an idle queue', () => {
    expect(queueWarnings(queue(), T0)).toEqual([])
  })

  it('flags an oldest wait over the threshold', () => {
    const q = queue({ pending: 1, oldestPendingAt: new Date(T0).toISOString() })
    expect(queueWarnings(q, T0 + (OLDEST_WAIT_WARN_SECONDS - 1) * 1000)).toEqual([])
    const w = queueWarnings(q, T0 + OLDEST_WAIT_WARN_SECONDS * 1000)
    expect(w.map(x => x.kind)).toEqual(['oldest-wait'])
    expect(w[0].label).toBe('Waiting 5m 0s')
  })

  it('flags pending work with zero free slots only when replicas are at max', () => {
    const busy = { pending: 8, ackPending: 2, freeSlots: 0 }
    expect(queueWarnings(queue({ ...busy, replicas: 1, maxReplicas: 3 }), T0)).toEqual([])
    expect(queueWarnings(queue({ ...busy, replicas: 1 }), T0)).toEqual([]) // max unknown
    const w = queueWarnings(queue({ ...busy, replicas: 3, readyReplicas: 3, maxReplicas: 3 }), T0)
    expect(w.map(x => x.kind)).toEqual(['saturated'])
    expect(w[0].detail).toContain('8 pending')
  })

  it('does not flag saturation when nothing is pending', () => {
    expect(queueWarnings(queue({ ackPending: 6, freeSlots: 0, replicas: 3, maxReplicas: 3 }), T0)).toEqual([])
  })

  it('reports a read error instead of other warnings', () => {
    const w = queueWarnings(queue({ error: 'failed to read consumer', pending: 0 }), T0)
    expect(w.map(x => x.kind)).toEqual(['error'])
  })
})

describe('atMaxReplicas', () => {
  it('needs a known, positive max', () => {
    expect(atMaxReplicas(queue({ replicas: 3 }))).toBe(false)
    expect(atMaxReplicas(queue({ replicas: 0, maxReplicas: 0 }))).toBe(false)
    expect(atMaxReplicas(queue({ replicas: 3, maxReplicas: 3 }))).toBe(true)
  })
})

describe('appendSamples', () => {
  it('appends one sample per knight and skips errored knights', () => {
    const h = appendSamples({}, [queue({ pending: 8 }), queue({ knight: 'kay', error: 'x' })], T0)
    expect(Object.keys(h)).toEqual(['galahad'])
    expect(h.galahad).toEqual([{ t: T0, pending: 8, ackPending: 0, replicas: 1 }])
  })

  it('does not mutate its input and ignores a duplicate poll within 1s', () => {
    const h1 = appendSamples({}, [queue()], T0)
    const h2 = appendSamples(h1, [queue()], T0 + 500)
    const h3 = appendSamples(h2, [queue()], T0 + 15_000)
    expect(h1.galahad).toHaveLength(1)
    expect(h2.galahad).toHaveLength(1)
    expect(h3.galahad).toHaveLength(2)
  })

  it('drops samples older than the retention window', () => {
    let h = appendSamples({}, [queue()], T0, 60_000)
    h = appendSamples(h, [queue({ knight: 'kay' })], T0 + 61_000, 60_000)
    expect(h.galahad).toBeUndefined()
    expect(h.kay).toHaveLength(1)
  })
})

describe('scaleEvents', () => {
  it('marks replica changes between samples', () => {
    const s = [1, 1, 3, 3, 2].map((replicas, i) => ({ t: T0 + i * 15_000, pending: 0, ackPending: 0, replicas }))
    expect(scaleEvents(s)).toEqual([
      { t: T0 + 30_000, from: 1, to: 3, direction: 'up' },
      { t: T0 + 60_000, from: 3, to: 2, direction: 'down' },
    ])
  })
})

describe('grafanaKnightUrl', () => {
  it('adds var-knight to an http(s) URL', () => {
    expect(grafanaKnightUrl('https://g.example.com/d/q?orgId=1', 'kay'))
      .toBe('https://g.example.com/d/q?orgId=1&var-knight=kay')
    expect(grafanaKnightUrl('https://g.example.com/d/q')).toBe('https://g.example.com/d/q')
  })
  it('rejects missing, relative and non-http URLs', () => {
    expect(grafanaKnightUrl(undefined, 'kay')).toBeNull()
    expect(grafanaKnightUrl('/grafana', 'kay')).toBeNull()
    expect(grafanaKnightUrl('javascript:alert(1)', 'kay')).toBeNull()
  })
})
