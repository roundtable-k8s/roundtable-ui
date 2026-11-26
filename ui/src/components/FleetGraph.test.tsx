import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { KnightNode } from './FleetGraph'

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
