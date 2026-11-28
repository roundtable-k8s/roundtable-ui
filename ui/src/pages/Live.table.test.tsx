import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { LivePage } from './Live'
import type { NatsEvent } from '../hooks/useWebSocket'

const events: NatsEvent[] = [
  { type: 'task', subject: 'a.tasks.x.t1', timestamp: '2026-11-24T10:00:00Z', table: 'a', data: { task: 'task in a' } },
  { type: 'task', subject: 'b.tasks.x.t2', timestamp: '2026-11-24T10:01:00Z', table: 'b', data: { task: 'task in b' } },
  { type: 'task', subject: 'old.tasks.x.t3', timestamp: '2026-11-24T10:02:00Z', data: { task: 'task untagged' } },
]
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events, connected: true }) }))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => ({ knights: [], error: null }) }))
vi.mock('../components/FleetGraph', () => ({ FleetGraph: () => <div data-testid="graph" /> }))
vi.mock('../components/KnightDetailDrawer', () => ({ KnightDetailDrawer: () => null }))
vi.mock('../components/TaskActivityPanel', () => ({ TaskActivityPanel: () => null }))

describe('LivePage table filter', () => {
  it('shows only the selected table and untagged events', () => {
    render(<MemoryRouter initialEntries={['/live?table=a']}><LivePage /></MemoryRouter>)
    expect(screen.getByText('task in a')).toBeInTheDocument()
    expect(screen.getByText('task untagged')).toBeInTheDocument()
    expect(screen.queryByText('task in b')).toBeNull()
    expect(screen.getByText('(2 events)')).toBeInTheDocument()
  })

  it('shows every event with no table selected', () => {
    render(<MemoryRouter initialEntries={['/live']}><LivePage /></MemoryRouter>)
    expect(screen.getByText('(3 events)')).toBeInTheDocument()
  })
})
