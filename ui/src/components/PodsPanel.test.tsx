import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { PodsPanel } from './PodsPanel'
import { ReplicaDots } from './ReplicaDots'
import { KnightCard } from './KnightCard'
import type { Knight, KnightPod } from '../hooks/useFleet'

const pod = (o: Partial<KnightPod>): KnightPod => ({ name: 'galahad-a', node: 'node-1', phase: 'Running', ready: true, restarts: 0, age: '5m', draining: false, ...o })
const base: Knight = { name: 'galahad', domain: 'security', status: 'online', ready: true, restarts: 0, age: '1h', image: 'img', skills: 0, nixTools: 0, labels: {} }
const scaling = { autoscaled: true, minReplicas: 0, maxReplicas: 5, desiredReplicas: 3, currentReplicas: 3, readyReplicas: 2 }

describe('PodsPanel', () => {
  it('shows scaling summary and three pods with node, restarts, usage bars and draining', () => {
    const k: Knight = { ...base, scaling, pods: [
      pod({ name: 'galahad-a', cpu: '500m', cpuLimit: '1', memory: '128Mi', memoryLimit: '256Mi', restarts: 2, lastTerminationReason: 'OOMKilled' }),
      pod({ name: 'galahad-b', node: 'node-2', ready: false, phase: 'Pending' }),
      pod({ name: 'galahad-c', draining: true }),
    ] }
    render(<MemoryRouter><PodsPanel knight={k} /></MemoryRouter>)
    expect(screen.getByText('Autoscaled')).toBeInTheDocument()
    expect(screen.getByText('min 0 / max 5')).toBeInTheDocument()
    expect(screen.getByText('desired 3')).toBeInTheDocument()
    expect(screen.getByText('node-2')).toBeInTheDocument()
    expect(screen.getByText('OOMKilled')).toBeInTheDocument()
    expect(screen.getByText('Draining')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'galahad-a CPU' })).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByRole('progressbar', { name: 'galahad-a memory' })).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getAllByRole('link', { name: 'Tasks' })).toHaveLength(3)
  })

  it('notes missing metrics but still lists pods', () => {
    render(<MemoryRouter><PodsPanel knight={{ ...base, pods: [pod({})] }} /></MemoryRouter>)
    expect(screen.getByText(/metrics-server/)).toBeInTheDocument()
    expect(screen.getByText('galahad-a')).toBeInTheDocument()
  })

  it('shows scaled to zero message', () => {
    render(<MemoryRouter><PodsPanel knight={{ ...base, status: 'scaled-to-zero', pods: [], scaling: { ...scaling, currentReplicas: 0, readyReplicas: 0, desiredReplicas: 0 } }} /></MemoryRouter>)
    expect(screen.getByText(/Scaled to zero/)).toBeInTheDocument()
  })
})

describe('ReplicaDots / KnightCard', () => {
  it('renders ready, starting and draining dots with current/max', () => {
    const k: Knight = { ...base, scaling, pods: [pod({ name: 'a' }), pod({ name: 'b', ready: false }), pod({ name: 'c', draining: true })] }
    const { container } = render(<ReplicaDots knight={k} />)
    expect(container.querySelector('[data-state="ready"]')).not.toBeNull()
    expect(container.querySelector('[data-state="starting"]')).not.toBeNull()
    expect(container.querySelector('[data-state="draining"]')).not.toBeNull()
    expect(screen.getByText('3/5')).toBeInTheDocument()
  })

  it('card shows scaled to zero, not offline', () => {
    const k: Knight = { ...base, status: 'scaled-to-zero', ready: false, pods: [], scaling: { ...scaling, currentReplicas: 0, readyReplicas: 0, desiredReplicas: 0 } }
    render(<KnightCard knight={k} />)
    expect(screen.getAllByText(/scaled to zero/i).length).toBeGreaterThan(0)
    expect(screen.queryByText('offline')).toBeNull()
  })
})
