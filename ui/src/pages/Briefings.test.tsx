import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BriefingsPage } from './Briefings'

const apiGet = vi.fn()
const apiGetText = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiGetText: (...a: unknown[]) => apiGetText(...a),
}))

describe('BriefingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGetText.mockResolvedValue('# hi')
  })

  it('shows an error, not the empty state, when the list fails', async () => {
    apiGet.mockRejectedValue(new Error('HTTP 500'))
    render(<BriefingsPage />)
    expect(await screen.findByText(/Failed to load briefings: HTTP 500/)).toBeInTheDocument()
    expect(screen.queryByText('No briefings yet')).not.toBeInTheDocument()
  })

  it('shows the empty state when the list is genuinely empty', async () => {
    apiGet.mockResolvedValue([])
    render(<BriefingsPage />)
    expect((await screen.findAllByText('No briefings yet')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument()
  })

  it('shows each entry directory in the list and the selected one in the header', async () => {
    apiGet.mockResolvedValue([
      { name: '2024-01-02.md', dir: 'Agents/Briefings' },
      { name: '2024-01-01.md', dir: 'Briefings/Daily' },
    ])
    render(<BriefingsPage />)
    const rows = await screen.findAllByRole('button', { name: /2024-01-0/ })
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Agents/Briefings')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Briefings/Daily')).toBeInTheDocument()
    expect(await screen.findByTitle('Source directory')).toHaveTextContent('Agents/Briefings')
    await userEvent.click(rows[1])
    await waitFor(() => expect(screen.getByTitle('Source directory')).toHaveTextContent('Briefings/Daily'))
  })
})
