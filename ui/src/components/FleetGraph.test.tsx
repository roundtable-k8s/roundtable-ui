import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { KnightNode, FleetGraph, buildEdges } from './FleetGraph'
import type { NatsEvent } from '../hooks/useWebSocket'
import type { Knight } from '../hooks/useFleet'

// React Flow measures nodes with ResizeObserver, which jsdom does not provide
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

const base = { label: 'galahad', emoji: '🛡', domain: 'security', color: '#fff', heat: 0, recentTasks: 0 }
type KnightNodeProps = Parameters<typeof KnightNode>[0]
const nodeProps = (status: string, busy: boolean): KnightNodeProps => ({
  id: 'galahad', type: 'knight', data: { ...base, status, busy },
  selected: false, dragging: false, draggable: false, selectable: false, deletable: false,
  isConnectable: false, zIndex: 0, positionAbsoluteX: 0, positionAbsoluteY: 0,
})
const renderNode = (status: string, busy: boolean) =>
  render(
    <ReactFlowProvider>
      <KnightNode {...nodeProps(status, busy)} />
    </ReactFlowProvider>,
  )

describe('KnightNode status text', () => {
  it('says online when idle', () => {
    renderNode('online', false)
    expect(screen.getByText('online')).toBeInTheDocument()
  })
  it('says busy when online and busy', () => {
    renderNode('online', true)
    expect(screen.getByText('busy')).toBeInTheDocument()
  })
  it('shows the offline status as text', () => {
    renderNode('offline', false)
    expect(screen.getByText('offline')).toBeInTheDocument()
  })
})

const fleet = (...names: string[]) =>
  names.map((name) => ({ name, domain: name, status: 'online' })) as unknown as Knight[]

const taskEvent = (domain: string, from = '', taskId = 't1'): NatsEvent => ({
  type: 'task',
  subject: `fleet-a.tasks.${domain}.${taskId}`,
  data: { from, task_id: taskId },
  timestamp: '2026-06-10T12:00:00Z',
  live: true,
})

describe('FleetGraph knight nodes', () => {
  it('draws knights that arrive after mount', async () => {
    const { container, rerender } = render(
      <FleetGraph knights={[]} events={[]} connected />,
    )
    rerender(<FleetGraph knights={fleet('galahad', 'kay')} events={[]} connected />)
    await waitFor(() =>
      expect(container.querySelectorAll('.react-flow__node-knight')).toHaveLength(2),
    )
  })

  it('does not loop when knightStatuses is omitted', () => {
    render(<FleetGraph knights={fleet('galahad')} events={[]} connected />)
    expect(document.querySelectorAll('.react-flow__node-knight')).toHaveLength(1)
  })
})

describe('buildEdges with hyphenated knights', () => {
  const names = ['galahad', 'coder-1']

  it('upgrades the Tim edge for a coder-1 task instead of splitting the name', () => {
    const edges = buildEdges(names, [taskEvent('coder-1', '', 't1'), taskEvent('coder-1', '', 't2')])
    const edge = edges.find((e) => e.source === 'tim' && e.target === 'coder-1')
    expect(edge).toBeDefined()
    expect(edge?.label).toBe('2')
    expect(edges.filter((e) => e.target === 'coder' || e.source === 'coder')).toHaveLength(0)
  })

  it('draws a knight-to-knight edge with the full hyphenated name', () => {
    const edges = buildEdges(names, [taskEvent('coder-1', 'galahad')])
    expect(edges.find((e) => e.source === 'galahad' && e.target === 'coder-1')).toBeDefined()
  })

  it('never emits an edge whose endpoint is not a node', () => {
    const nodeIds = new Set(['tim', ...names])
    const edges = buildEdges(names, [taskEvent('coder-1', 'galahad'), taskEvent('unknown-knight', 'coder-1')])
    for (const e of edges) {
      expect(nodeIds.has(e.source)).toBe(true)
      expect(nodeIds.has(e.target)).toBe(true)
    }
  })
})
