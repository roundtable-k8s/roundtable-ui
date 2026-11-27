import { describe, it, expect } from 'vitest'
import { glanceItems, type GlanceInput } from './glance'

const ok: GlanceInput = {
  health: { kubernetes: 'ok', nats: 'connected' },
  knights: [{ status: 'online' }],
  deadLetters: { count: 0 },
  schedules: [{ lastResult: { time: 't', outcome: 'succeeded' } }],
  queues: [],
}
const ids = (i: GlanceInput) => glanceItems(i).map((x) => x.id)

describe('glanceItems', () => {
  it('collapses a healthy fleet into All clear', () => {
    expect(glanceItems(ok)).toEqual([{ id: 'all-clear', label: 'All clear', tone: 'ok', to: '/' }])
  })
  it('warns on NATS reconnecting, bad when disconnected or k8s unavailable', () => {
    expect(glanceItems({ ...ok, health: { kubernetes: 'ok', nats: 'reconnecting' } })[0]).toMatchObject({ id: 'api', tone: 'warn' })
    expect(glanceItems({ ...ok, health: { kubernetes: 'ok', nats: 'disconnected' } })[0].tone).toBe('bad')
    expect(glanceItems({ ...ok, health: { kubernetes: 'unavailable', nats: 'connected' } })[0].tone).toBe('bad')
  })
  it('reports offline knights, open failed tasks and failing schedules with links', () => {
    const r = glanceItems({
      ...ok,
      knights: [{ status: 'offline' }, { status: 'offline' }, { status: 'online' }],
      deadLetters: { count: 2 },
      schedules: [{ lastResult: { time: 't', outcome: 'failed' } }, { lastResult: { time: 't', outcome: 'lost' } }, {}],
    })
    expect(r).toEqual([
      { id: 'knights', label: '2 knights not ready', tone: 'bad', to: '/fleet?status=offline' },
      { id: 'failed', label: '2 open failed tasks', tone: 'bad', to: '/failed' },
      { id: 'schedules', label: '2 schedules failing', tone: 'bad', to: '/schedules' },
    ])
  })
  it('flags queues with a warning', () => {
    const q = { consumerFound: true, oldestWaitSeconds: 900, pending: 1, freeSlots: 0 } as never
    expect(glanceItems({ ...ok, queues: [q] })).toEqual([{ id: 'queues', label: '1 queue backed up', tone: 'warn', to: '/queues' }])
  })
  it('treats a failed source as unknown, never ok', () => {
    expect(ids({ health: null, knights: null, deadLetters: null, schedules: null, queues: null })).toEqual(['api', 'knights', 'failed', 'schedules', 'queues'])
    expect(glanceItems({ ...ok, queues: null })).toEqual([{ id: 'queues', label: 'Queues unknown', tone: 'unknown', to: '/queues' }])
  })
  it('shows the API chip as unknown when the health poll failed after a success', () => {
    const stale = { ...ok, health: { kubernetes: 'ok', nats: 'connected', error: true } }
    expect(glanceItems(stale)).toEqual([{ id: 'api', label: 'API status unknown', tone: 'unknown', to: '/' }])
  })
  it('shows failed tasks as unknown before the first dead-letter answer', () => {
    expect(glanceItems({ ...ok, deadLetters: { count: 0, capped: false, loading: true } })).toEqual([
      { id: 'failed', label: 'Failed tasks unknown', tone: 'unknown', to: '/failed' },
    ])
  })
  it('shows failed tasks as unknown when the dead-letter poll failed', () => {
    expect(glanceItems({ ...ok, deadLetters: { count: 0, capped: false, error: true } })).toEqual([
      { id: 'failed', label: 'Failed tasks unknown', tone: 'unknown', to: '/failed' },
    ])
  })
})
