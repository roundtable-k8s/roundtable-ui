import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueueSparkline } from './QueueSparkline'
import type { QueueSample } from '../lib/queues'

const s = (t: string, pending: number | null, replicas: number): QueueSample =>
  ({ t, pending, ackPending: 2, redelivered: 0, waiting: 0, replicas, readyReplicas: replicas, maxReplicas: 3 })

describe('QueueSparkline', () => {
  it('waits for at least two samples', () => {
    render(<QueueSparkline knight="a" samples={[s('2026-11-24T10:00:00Z', 1, 1)]} events={[]} />)
    expect(screen.getByText('Collecting samples…')).toBeInTheDocument()
  })

  it('describes itself and shows the nearest sample on hover', () => {
    const samples = [s('2026-11-24T10:00:00Z', 8, 1), s('2026-11-24T10:00:15Z', null, 2), s('2026-11-24T10:00:30Z', 4, 2)]
    render(<QueueSparkline knight="galahad" samples={samples}
      events={[{ t: '2026-11-24T10:00:10Z', direction: 'down', from: 2, to: 1, reason: '', source: 'sample' }]} />)
    const svg = screen.getByRole('img')
    expect(svg.getAttribute('aria-label')).toContain('now 4 pending, 2 replicas, 1 scale events')
    expect(screen.getByTestId('scale-event').textContent).toContain('▼ 2 → 1 replicas (sample)')
    // jsdom has a zero-size rect, so the pointer maps to x=0: the first sample
    fireEvent.mouseMove(svg, { clientX: 0 })
    expect(screen.getByText('8 pending · 2 in flight')).toBeInTheDocument()
    expect(screen.getByText('1/1 ready · max 3')).toBeInTheDocument()
    fireEvent.mouseLeave(svg)
    expect(screen.queryByText('8 pending · 2 in flight')).toBeNull()
  })
})
