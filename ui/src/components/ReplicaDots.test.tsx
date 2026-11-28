import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReplicaDots } from './ReplicaDots'
import type { Knight, KnightPod } from '../hooks/useFleet'

function pod(name: string, over: Partial<KnightPod> = {}): KnightPod {
  return { name, phase: 'Running', ready: true, restarts: 0, age: '1h', draining: false, ...over }
}
function knight(over: Partial<Knight> = {}): Knight {
  return { name: 'galahad', domain: 'security', status: 'online', ready: true, restarts: 0, age: '1h', image: 'i', labels: {}, ...over }
}
const scaling = (over = {}) => ({ autoscaled: true, minReplicas: 0, maxReplicas: 3, currentReplicas: 2, readyReplicas: 1, ...over })

describe('ReplicaDots', () => {
  it('renders nothing without pods or scaling', () => {
    const { container } = render(<ReplicaDots knight={knight()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows scaled to zero when parked', () => {
    render(<ReplicaDots knight={knight({ status: 'scaled-to-zero', pods: [], scaling: scaling({ currentReplicas: 0 }) })} />)
    expect(screen.getByTestId('replicas')).toHaveTextContent('Scaled to zero · 0/3')
  })

  it('shows one dot per pod with its state and the summary', () => {
    render(<ReplicaDots knight={knight({
      pods: [pod('a'), pod('b', { ready: false }), pod('c', { draining: true })],
      scaling: scaling({ currentReplicas: 3 }),
    })} />)
    const dots = screen.getByTestId('replicas').querySelectorAll('[data-state]')
    expect(Array.from(dots).map((d) => d.getAttribute('data-state'))).toEqual(['ready', 'starting', 'draining'])
    expect(screen.getByText('1 ready, 1 starting, 1 draining, max 3')).toBeInTheDocument()
    expect(screen.getByText('3/3')).toBeInTheDocument()
  })

  it('uses the pod count as max without scaling info', () => {
    render(<ReplicaDots knight={knight({ pods: [pod('a'), pod('b')] })} />)
    expect(screen.getByText('2 ready, max 2')).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })
})
