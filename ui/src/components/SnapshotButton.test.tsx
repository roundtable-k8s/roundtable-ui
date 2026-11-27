import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { SnapshotButton } from './SnapshotButton'
import type { Knight } from '../hooks/useFleet'

const k = (over: Partial<Knight> = {}): Knight => ({
  name: 'galahad', domain: 'dev', status: 'online', ready: true, restarts: 0, age: '1h', image: 'img', skills: 0, nixTools: 0, labels: {}, ...over,
})
const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const fetchMock = vi.fn()
let detail: Knight

function Host() {
  const [knight, setKnight] = useState(k())
  return <><SnapshotButton name="galahad" namespace="roundtable" knight={knight} onDetail={setKnight} />
    <ul>{(knight.workspaceSnapshots ?? []).map((s) => <li key={s.name}>{s.name}</li>)}</ul></>
}

beforeEach(() => {
  vi.useFakeTimers()
  detail = k()
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve(res(202, { expectedName: 'snap-1', note: 'Knight is suspended; it snapshots on resume.' }))
    return Promise.resolve(res(200, detail))
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers() })

const click = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Take snapshot/ })) }) }
const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')

describe('SnapshotButton', () => {
  it('posts once with the namespace, shows note and expected name, then the new snapshot stops polling', async () => {
    render(<Host />)
    await click()
    expect(posts()).toHaveLength(1)
    expect(posts()[0][0]).toBe('/api/knights/galahad/snapshot?namespace=roundtable')
    expect(screen.getByText(/snapshots on resume/)).toBeInTheDocument()
    expect(screen.getByText('snap-1')).toBeInTheDocument()

    detail = k({ workspaceSnapshots: [{ name: 'snap-1', createdAt: '2026-01-01T00:00:00Z', readyToUse: false }] })
    await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
    expect(screen.getByRole('listitem')).toHaveTextContent('snap-1')
    expect(screen.queryByText(/Expected:/)).not.toBeInTheDocument()
    const gets = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(fetchMock.mock.calls.length).toBe(gets)
  })

  it('stops polling after 60 s', async () => {
    render(<Host />)
    await click()
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const gets = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(fetchMock.mock.calls.length).toBe(gets)
  })

  it.each([
    [409, /moment ago/],
    [422, /pvc workspace/],
    [404, /not enabled/],
  ])('maps %i to a plain sentence', async (status, re) => {
    fetchMock.mockImplementation(() => Promise.resolve(res(status, { error: 'raw' })))
    render(<Host />)
    await click()
    expect(screen.getByRole('alert')).toHaveTextContent(re)
  })

  it('disables itself while pending', async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { resolve = r }))
    render(<Host />)
    await click()
    expect(screen.getByRole('button', { name: /Requesting/ })).toBeDisabled()
    await act(async () => { resolve(res(202, {})) })
    expect(screen.getByRole('button', { name: /Take snapshot/ })).toBeEnabled()
  })
})
