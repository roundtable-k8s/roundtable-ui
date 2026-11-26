import { describe, it, expect } from 'vitest'
import {
  formatWait, latestMaxReplicas, queueWarnings, safeExternalUrl, sparkGeometry, sparkPath,
  type KnightQueue, type KnightQueueHistory, type QueueSample,
} from './queues'

function makeQueue(over: Partial<KnightQueue> = {}): KnightQueue {
  return {
    knight: 'galahad', stream: 'fleet_a_tasks', consumer: 'galahad-consumer', consumerFound: true,
    pending: 0, ackPending: 0, redelivered: 0, waiting: 2,
    delivered: { consumerSeq: 0, streamSeq: 0 }, ackFloor: { consumerSeq: 0, streamSeq: 0 },
    oldestWaitSeconds: 0, concurrency: 2, replicas: 1, readyReplicas: 1, freeSlots: 2,
    ...over,
  }
}

function sample(t: string, over: Partial<QueueSample> = {}): QueueSample {
  return { t, pending: 0, ackPending: 0, redelivered: 0, waiting: 0, replicas: 1, readyReplicas: 1, ...over }
}

describe('formatWait', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatWait(0)).toBe('—')
    expect(formatWait(undefined)).toBe('—')
    expect(formatWait(45.7)).toBe('45s')
    expect(formatWait(120)).toBe('2m 0s')
    expect(formatWait(200)).toBe('3m 20s')
    expect(formatWait(3900)).toBe('1h 5m')
  })
})

describe('queueWarnings', () => {
  it('is empty for an idle queue', () => {
    expect(queueWarnings(makeQueue(), 3)).toEqual([])
  })

  it('flags an oldest wait over the threshold', () => {
    const w = queueWarnings(makeQueue({ pending: 8, oldestWaitSeconds: 301, freeSlots: 0 }), 3, 300)
    expect(w.map(x => x.kind)).toEqual(['oldest-wait'])
  })

  it('flags saturation only when replicas are at max', () => {
    const q = makeQueue({ pending: 8, freeSlots: 0, replicas: 3, readyReplicas: 3 })
    expect(queueWarnings(q, 3).map(x => x.kind)).toEqual(['saturated'])
    expect(queueWarnings(q, 5)).toEqual([])
    expect(queueWarnings(q, undefined)).toEqual([])
  })

  it('does not flag ack-pending-only queues as saturated', () => {
    expect(queueWarnings(makeQueue({ ackPending: 2, freeSlots: 0, replicas: 1 }), 1)).toEqual([])
  })

  it('ignores knights without a consumer or with an error', () => {
    expect(queueWarnings(makeQueue({ consumerFound: false, oldestWaitSeconds: 9999 }), 1)).toEqual([])
    expect(queueWarnings(makeQueue({ error: 'x', oldestWaitSeconds: 9999 }), 1)).toEqual([])
  })
})

describe('latestMaxReplicas', () => {
  it('returns the last known max', () => {
    const h: KnightQueueHistory = {
      knight: 'a', intervalSeconds: 15, retentionSeconds: 21600, events: [],
      samples: [sample('2026-11-24T10:00:00Z', { maxReplicas: 2 }), sample('2026-11-24T10:00:15Z', { maxReplicas: 4 }), sample('2026-11-24T10:00:30Z')],
    }
    expect(latestMaxReplicas(h)).toBe(4)
    expect(latestMaxReplicas(undefined)).toBeUndefined()
  })
})

describe('safeExternalUrl', () => {
  it('only allows http(s)', () => {
    expect(safeExternalUrl('https://grafana.example/d/q?var-knight=a')).toBe('https://grafana.example/d/q?var-knight=a')
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalUrl('not a url')).toBeUndefined()
    expect(safeExternalUrl(undefined)).toBeUndefined()
  })
})

describe('sparkGeometry / sparkPath', () => {
  const samples = [
    sample('2026-11-24T10:00:00Z', { pending: 0 }),
    sample('2026-11-24T10:00:15Z', { pending: 8 }),
    sample('2026-11-24T10:00:30Z', { pending: null, replicas: 2 }),
    sample('2026-11-24T10:00:45Z', { pending: 4, replicas: 2 }),
  ]
  const events = [
    { t: '2026-11-24T10:00:20Z', direction: 'up', from: 1, to: 2, reason: 'external metric above target', source: 'hpa' },
    { t: '2026-11-24T09:00:00Z', direction: 'up', to: 1, reason: 'old', source: 'hpa' },
  ]

  it('scales each chart to its own max and keeps events in range', () => {
    const g = sparkGeometry(samples, events, 300, 30)
    expect(g.pendingMax).toBe(8)
    expect(g.replicasMax).toBe(2)
    expect(g.pending.map(p => p.x)).toEqual([0, 100, 200, 300])
    expect(g.pending[1].y).toBe(0)
    expect(g.pending[0].y).toBe(30)
    expect(g.pending[2].y).toBeNull()
    expect(g.events).toHaveLength(1)
    expect(g.events[0].x).toBeCloseTo(133.3, 1)
  })

  it('breaks the line at gaps and draws steps', () => {
    const g = sparkGeometry(samples, [], 300, 30)
    expect(sparkPath(g.pending)).toBe('M0.0,30.0L100.0,0.0M300.0,15.0')
    expect(sparkPath(g.replicas, true)).toBe('M0.0,15.0H100.0V15.0H200.0V0.0H300.0V0.0')
  })
})
