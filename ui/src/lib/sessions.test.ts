import { describe, it, expect } from 'vitest'
import { groupSessions, groupLabel, podGoneFrom, parseSessionTarget, pickTargetSession, sessionsLink } from './sessions'
import type { SessionHistoryItem } from '../hooks/useKnightSession'

const item = (id: string, over: Partial<SessionHistoryItem> = {}): SessionHistoryItem =>
  ({ id, startedAt: null, entryCount: 1, messageCount: 1, firstPrompt: '', sizeBytes: null, ...over })

const shape = (groups: ReturnType<typeof groupSessions>) =>
  groups.map(r => ({ run: r.runId, pods: r.pods.map(p => ({ pod: p.pod, ids: p.sessions.map(s => s.id) })) }))

describe('groupSessions', () => {
  // Three replicas, two runs, plus a session without a run.
  const items = [
    item('s1', { runId: 'run-a', pod: 'galahad-c', startedAt: '2026-11-24T10:00:00Z' }),
    item('s2', { runId: 'run-b', pod: 'galahad-a', startedAt: '2026-11-24T12:00:00Z' }),
    item('s3', { runId: 'run-a', pod: 'galahad-a', startedAt: '2026-11-24T09:00:00Z' }),
    item('s4', { pod: 'galahad-b', startedAt: '2026-11-24T13:00:00Z' }),
    item('s5', { runId: 'run-a', pod: 'galahad-a', startedAt: '2026-11-24T11:00:00Z' }),
    item('s6', { runId: 'run-b', pod: 'galahad-b', startedAt: '2026-11-24T12:30:00Z' }),
  ]

  it('groups by run, then pod, then session', () => {
    expect(shape(groupSessions(items))).toEqual([
      { run: 'run-b', pods: [{ pod: 'galahad-a', ids: ['s2'] }, { pod: 'galahad-b', ids: ['s6'] }] },
      { run: 'run-a', pods: [{ pod: 'galahad-a', ids: ['s5', 's3'] }, { pod: 'galahad-c', ids: ['s1'] }] },
      { run: null, pods: [{ pod: 'galahad-b', ids: ['s4'] }] },
    ])
  })

  it('gives the same grouping whatever order the pods answered in (no flitting on refresh)', () => {
    const want = shape(groupSessions(items))
    for (let i = 0; i < 6; i++) {
      const rotated = [...items.slice(i), ...items.slice(0, i)].reverse()
      expect(shape(groupSessions(rotated))).toEqual(want)
    }
  })

  it('never moves a session to another pod', () => {
    for (const run of groupSessions(items)) {
      for (const pg of run.pods) {
        for (const s of pg.sessions) expect(s.pod).toBe(pg.pod)
      }
    }
  })

  it('orders equal or missing timestamps by id', () => {
    const g = groupSessions([item('b', { pod: 'p' }), item('a', { pod: 'p' }), item('c', { pod: 'p', startedAt: 'bogus' })])
    expect(shape(g)).toEqual([{ run: null, pods: [{ pod: 'p', ids: ['a', 'b', 'c'] }] }])
  })

  it('puts sessions without a pod (older runtime) after named pods', () => {
    const g = groupSessions([item('x'), item('y', { pod: 'galahad-a' })])
    expect(g[0].pods.map(p => p.pod)).toEqual(['galahad-a', null])
  })
})

describe('groupLabel', () => {
  it('names run and pod', () => {
    expect(groupLabel('run-a', 'galahad-a')).toBe('Run run-a · pod galahad-a')
    expect(groupLabel(null, 'galahad-a')).toBe('No run · pod galahad-a')
    expect(groupLabel(null, null)).toBe('No run')
  })
})

describe('podGoneFrom', () => {
  it('reads the pod from a 410 body', async () => {
    const res = new Response(JSON.stringify({ error: 'pod gone', podGone: true, pod: 'galahad-x' }), { status: 410 })
    expect(await podGoneFrom(res, 'other')).toBe('galahad-x')
  })

  it('falls back to the requested pod when podGone is set without a pod', async () => {
    expect(await podGoneFrom(new Response('{"podGone":true}', { status: 410 }), 'galahad-y')).toBe('galahad-y')
  })

  it('ignores a 410 without podGone: true (e.g. from a proxy)', async () => {
    expect(await podGoneFrom(new Response('gone', { status: 410 }), 'galahad-y')).toBeNull()
    expect(await podGoneFrom(new Response('{"error":"gone","pod":"x"}', { status: 410 }), 'galahad-y')).toBeNull()
    expect(await podGoneFrom(new Response('{"podGone":"yes"}', { status: 410 }), 'galahad-y')).toBeNull()
  })

  it('is null for other responses and for client timeouts', async () => {
    expect(await podGoneFrom(new Response('{}', { status: 200 }), 'p')).toBeNull()
    expect(await podGoneFrom(new Response('nope', { status: 404 }), 'p')).toBeNull()
    expect(await podGoneFrom(null, 'p')).toBeNull()
  })
})

describe('deep links', () => {
  it('builds and parses /sessions?knight=&pod=&runId=', () => {
    const link = sessionsLink('Galahad', 'galahad-abc', 'run-9')
    expect(link).toBe('/sessions?knight=galahad&pod=galahad-abc&runId=run-9')
    expect(parseSessionTarget(new URLSearchParams(link.split('?')[1]))).toEqual({ pod: 'galahad-abc', runId: 'run-9' })
    expect(sessionsLink('galahad')).toBe('/sessions?knight=galahad')
  })

  it('drops invalid pod/runId values', () => {
    expect(parseSessionTarget(new URLSearchParams('pod=Galahad*&runId=a b'))).toEqual({ pod: null, runId: null })
  })

  it('picks the newest session of the run on the linked pod, else the pod\'s newest', () => {
    const list = [
      item('old', { pod: 'p1', runId: 'r1', startedAt: '2026-11-24T08:00:00Z' }),
      item('new', { pod: 'p1', runId: 'r1', startedAt: '2026-11-24T09:00:00Z' }),
      item('other', { pod: 'p1', runId: 'r2', startedAt: '2026-11-24T10:00:00Z' }),
      item('elsewhere', { pod: 'p2', runId: 'r1', startedAt: '2026-11-24T11:00:00Z' }),
    ]
    expect(pickTargetSession(list, 'p1', 'r1')?.id).toBe('new')
    expect(pickTargetSession(list, 'p1', 'r3')?.id).toBe('other')
    expect(pickTargetSession(list, 'p3', 'r1')).toBeNull()
    expect(pickTargetSession(list, null, null)).toBeNull()
  })
})
