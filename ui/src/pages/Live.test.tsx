import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { LivePage } from './Live'
import { Spinner, ErrorBanner } from '../components/ui'
import type { NatsEvent } from '../hooks/useWebSocket'

const events: NatsEvent[] = [
  { type: 'task', subject: 'fleet.tasks.security.t1', timestamp: '2026-11-24T10:00:00Z', data: { task: 'scan the cluster' } },
  { type: 'task', subject: 'fleet.tasks.research.t2', timestamp: '2026-11-24T10:01:00Z', data: { task: 'fix the page' } },
  { type: 'result', subject: 'fleet.results.t1', timestamp: '2026-11-24T10:02:00Z', data: { task_id: 't1', knight: 'Galahad', success: true, result: 'scan clean' } },
]
const knights = [
  { name: 'galahad', domain: 'security', status: 'online' },
  { name: 'kay', domain: 'research', status: 'online' },
]

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events, connected: true }) }))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => ({ knights, error: null }) }))
vi.mock('../components/FleetGraph', () => ({ FleetGraph: () => <div data-testid="graph" /> }))
vi.mock('../components/KnightDetailDrawer', () => ({ KnightDetailDrawer: () => null }))
vi.mock('../components/TaskActivityPanel', () => ({ TaskActivityPanel: () => null }))

const renderPage = () => render(<MemoryRouter><LivePage /></MemoryRouter>)
const cards = () => screen.queryAllByText(/^(scan the cluster|fix the page|scan clean)$/).map((e) => e.textContent)

describe('LivePage filters', () => {
  it('labels the three filter selects', () => {
    renderPage()
    expect(screen.getByLabelText('Filter by knight')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by type')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter by domain')).toBeInTheDocument()
  })

  it('shows every event and the connection state by default', () => {
    renderPage()
    expect(cards()).toHaveLength(3)
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('(3 events)')).toBeInTheDocument()
  })

  it('narrows by type', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByDisplayValue('All Types'), 'result')
    expect(cards()).toEqual(['scan clean'])
    expect(screen.getByText('(1 events)')).toBeInTheDocument()
  })

  it('narrows by knight', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByDisplayValue('All Knights'), 'kay')
    expect(cards()).toEqual(['fix the page'])
  })

  it('narrows by domain, resolving a result through its knight', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByDisplayValue('All Domains'), 'security')
    expect(cards().sort()).toEqual(['scan clean', 'scan the cluster'])
  })

  it('combines filters and Clear resets them', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByDisplayValue('All Domains'), 'security')
    await userEvent.selectOptions(screen.getByDisplayValue('All Types'), 'task')
    expect(cards()).toEqual(['scan the cluster'])
    await userEvent.click(screen.getByText('Clear'))
    expect(cards()).toHaveLength(3)
  })

  it('shows the waiting state when a filter matches nothing', async () => {
    renderPage()
    await userEvent.selectOptions(screen.getByDisplayValue('All Knights'), 'kay')
    await userEvent.selectOptions(screen.getByDisplayValue('All Types'), 'result')
    expect(screen.getByText('Waiting for messages…')).toBeInTheDocument()
  })
})

describe('feedback primitives', () => {
  it('Spinner is a labelled status and ErrorBanner an alert', () => {
    render(<><Spinner /><ErrorBanner>boom</ErrorBanner></>)
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
})
