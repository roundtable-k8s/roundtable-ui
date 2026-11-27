import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ArchitecturePage } from './Architecture'
import { apiGet } from '../lib/api'
import type { Knight } from '../hooks/useFleet'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))

let knights: Knight[] = []
let knightsLoading = false
vi.mock('../hooks/useFleet', () => ({
  useFleet: () => ({ knights, loading: knightsLoading, error: null, refresh: vi.fn() }),
}))

const mockApiGet = vi.mocked(apiGet)

function knight(name: string, status: Knight['status']): Knight {
  return { name, domain: 'x', status, ready: true, restarts: 0, age: '1h', image: 'i', skills: 0, nixTools: 0, labels: {} }
}

function mockApi(rt: unknown, ms: unknown) {
  mockApiGet.mockImplementation((url: string) => {
    const v = url === '/api/roundtables' ? rt : ms
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v as never)
  })
}

const renderPage = () => render(<MemoryRouter><ArchitecturePage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  knights = [knight('galahad', 'online'), knight('kay', 'offline')]
  knightsLoading = false
})

describe('ArchitecturePage', () => {
  it('shows the spinner while loading', async () => {
    mockApiGet.mockImplementation(() => new Promise(() => {}))
    renderPage()
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText('Loading architecture data…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeDisabled()
  })

  it('renders live stats when both endpoints succeed', async () => {
    mockApi(
      [{ name: 'a', natsPrefix: 'fleet-a' }, { name: 'b', natsPrefix: 'fleet-b' }, { name: 'c', natsPrefix: 'fleet-a' }],
      [{ phase: 'Running' }, { phase: 'Succeeded' }, { phase: 'Failed' }, { phase: 'Expired' }],
    )
    renderPage()
    expect(await screen.findByText('3 RoundTables')).toBeInTheDocument()
    expect(screen.getByText('Streams: fleet-a, fleet-b')).toBeInTheDocument()
    expect(screen.getByText('1 active / 4 total missions')).toBeInTheDocument()
    expect(screen.getByText('Knights (2 agents)')).toBeInTheDocument()
    expect(screen.getByText('1 online')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Loading architecture data…')).toBeNull()
  })

  it('shows the API as connected and reports a missing NATS prefix', async () => {
    mockApi([{ name: 'a' }], [])
    renderPage()
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('no NATS prefix reported')).toBeInTheDocument()
    expect(screen.queryByText(/fleet-\*/)).toBeNull()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('shows the API as unreachable when both endpoints fail', async () => {
    mockApi(new Error('rt down'), new Error('missions down'))
    renderPage()
    expect(await screen.findByText('Unreachable')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('does not show version numbers in the tech stack', async () => {
    mockApi([], [])
    renderPage()
    await screen.findByText('Tech Stack')
    expect(screen.getByText('React + TypeScript')).toBeInTheDocument()
    expect(screen.queryByText(/React 1\d|Go 1\.\d/)).toBeNull()
  })

  it('still renders and shows a banner when one endpoint fails', async () => {
    mockApi([{ name: 'a', natsPrefix: 'fleet-a' }], new Error('missions down'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load architecture data: missions down')
    expect(screen.getByText('1 RoundTable')).toBeInTheDocument()
    expect(screen.getByText('0 active / 0 total missions')).toBeInTheDocument()
    expect(screen.getByText('Data Flow')).toBeInTheDocument()
  })

  it('uses a generic message for a non-Error rejection', async () => {
    mockApi('x', undefined)
    mockApiGet.mockImplementation((url: string) =>
      url === '/api/roundtables' ? Promise.reject('nope') : Promise.resolve([] as never))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown error')
  })

  it('refetches on refresh and clears the banner', async () => {
    mockApi([], new Error('boom'))
    renderPage()
    await screen.findByRole('alert')
    expect(mockApiGet).toHaveBeenCalledTimes(2)

    mockApi([], [])
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(4))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
