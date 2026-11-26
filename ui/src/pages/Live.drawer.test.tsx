import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { LivePage } from './Live'
import type { Knight } from '../hooks/useFleet'

let knights: Knight[] = []
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events: [], connected: true }) }))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => ({ knights, error: null }) }))
vi.mock('../components/FleetGraph', () => ({
  FleetGraph: ({ onKnightClick }: { onKnightClick: (n: string) => void }) => (
    <button onClick={() => onKnightClick('galahad')}>open galahad</button>
  ),
}))
vi.mock('../components/TaskActivityPanel', () => ({ TaskActivityPanel: () => null }))
vi.mock('../components/KnightDetailDrawer', () => ({
  KnightDetailDrawer: ({ knight }: { knight: Knight | null }) =>
    knight ? <div data-testid="drawer">{`${knight.status}:${knight.restarts}`}</div> : null,
}))

const real: Knight = {
  name: 'galahad', namespace: 'ns', domain: 'security', status: 'online', ready: true, restarts: 3,
  age: '1h', image: 'img', skills: 0, nixTools: 0, labels: {},
}

describe('Live detail drawer', () => {
  it('swaps the offline placeholder for the real knight once the fleet loads', async () => {
    knights = []
    const { rerender } = render(<MemoryRouter><LivePage /></MemoryRouter>)
    await userEvent.click(screen.getByText('open galahad'))
    expect(screen.getByTestId('drawer')).toHaveTextContent('offline:0')
    knights = [real]
    rerender(<MemoryRouter><LivePage /></MemoryRouter>)
    expect(screen.getByTestId('drawer')).toHaveTextContent('online:3')
  })

  it('follows a changed restart count on the next poll', async () => {
    knights = [real]
    const { rerender } = render(<MemoryRouter><LivePage /></MemoryRouter>)
    await userEvent.click(screen.getByText('open galahad'))
    knights = [{ ...real, restarts: 9 }]
    rerender(<MemoryRouter><LivePage /></MemoryRouter>)
    expect(screen.getByTestId('drawer')).toHaveTextContent('online:9')
  })
})
