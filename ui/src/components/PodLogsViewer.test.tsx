import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { PodLogsViewer, ALL_PODS } from './PodLogsViewer'
import type { KnightPodsResponse } from '../lib/podLogs'

const apiGet = vi.fn()
const apiGetText = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiGetText: (...a: unknown[]) => apiGetText(...a),
}))

const pod = (name: string, extra: Partial<KnightPodsResponse['pods'][number]> = {}) => ({
  name,
  phase: 'Running',
  ready: true,
  restarts: 0,
  containers: [
    { name: 'knight', ready: true, restartCount: 0, hasPrevious: false },
    { name: 'nats-sidecar', ready: true, restartCount: 0, hasPrevious: false },
  ],
  ...extra,
})

const podsResp: KnightPodsResponse = {
  pods: [pod('galahad-abc-2'), pod('galahad-abc-1'), pod('galahad-abc-3', { restarts: 3 })],
  default: 'galahad-abc-2',
}

const logsFor = (url: string) => {
  const p = new URL(url, 'http://x').searchParams.get('pod')
  const ts = url.includes('timestamps=true')
  const n = p?.slice(-1)
  return ts ? `2026-11-24T10:00:0${n}Z line from ${p}\n` : `line from ${p}\n`
}

beforeEach(() => {
  apiGet.mockReset().mockResolvedValue(podsResp)
  apiGetText.mockReset().mockImplementation(async (url: string) => logsFor(url))
})

const lastUrl = () => apiGetText.mock.calls.at(-1)![0] as string

describe('PodLogsViewer', () => {
  it('lists the pods and shows the default pod logs', async () => {
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent('line from galahad-abc-2'))
    expect(apiGet).toHaveBeenCalledWith('/api/fleet/galahad/pods')
    expect(lastUrl()).toBe('/api/fleet/galahad/logs?pod=galahad-abc-2')
    const select = screen.getByLabelText('Pod') as HTMLSelectElement
    expect(select.value).toBe('galahad-abc-2')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['abc-2', 'abc-1', 'abc-3 ↻3', 'All pods (merged)'])
  })

  it('shows the logs of the selected pod every time', async () => {
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent('galahad-abc-2'))
    for (const p of ['galahad-abc-1', 'galahad-abc-3', 'galahad-abc-2']) {
      fireEvent.change(screen.getByLabelText('Pod'), { target: { value: p } })
      await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent(`line from ${p}`))
      expect(lastUrl()).toBe(`/api/fleet/galahad/logs?pod=${p}`)
    }
  })

  it('passes container and previous', async () => {
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(apiGetText).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Container'), { target: { value: 'nats-sidecar' } })
    fireEvent.click(screen.getByLabelText('Previous'))
    await waitFor(() =>
      expect(lastUrl()).toBe('/api/fleet/galahad/logs?pod=galahad-abc-2&container=nats-sidecar&previous=true'),
    )
  })

  it('merges all pods with per-pod prefixes in time order', async () => {
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(apiGetText).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: ALL_PODS } })
    await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent('[abc-1]'))
    const rows = Array.from(screen.getByTestId('pod-logs').children).map((c) => c.textContent)
    expect(rows).toEqual([
      '[abc-1] line from galahad-abc-1',
      '[abc-2] line from galahad-abc-2',
      '[abc-3] line from galahad-abc-3',
    ])
    const prefixes = Array.from(screen.getByTestId('pod-logs').querySelectorAll('span')).map((s) => s.className)
    expect(new Set(prefixes).size).toBe(3)
    for (const p of podsResp.pods) {
      expect(apiGetText).toHaveBeenCalledWith(`/api/fleet/galahad/logs?pod=${p.name}&timestamps=true`)
    }
  })

  it('shows per-pod errors in merged mode', async () => {
    apiGetText.mockImplementation(async (url: string) => {
      if (url.includes('abc-3')) throw new Error('No previous container logs for this pod')
      return logsFor(url)
    })
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(apiGetText).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Pod'), { target: { value: ALL_PODS } })
    await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent('[abc-3] Error: No previous container logs'))
    expect(screen.getByTestId('pod-logs')).toHaveTextContent('[abc-1] line from galahad-abc-1')
  })

  it('shows a fetch error', async () => {
    apiGetText.mockRejectedValue(new Error('Pod not found for this knight'))
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent('Error: Pod not found for this knight'))
  })

  it('hides the merged option for a single pod', async () => {
    apiGet.mockResolvedValue({ pods: [pod('galahad-abc-1')], default: 'galahad-abc-1' })
    render(<PodLogsViewer knightName="galahad" />)
    await waitFor(() => expect(screen.getByTestId('pod-logs')).toHaveTextContent('galahad-abc-1'))
    expect(screen.queryByRole('option', { name: 'All pods (merged)' })).toBeNull()
  })
})
