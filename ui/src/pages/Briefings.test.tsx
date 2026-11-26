import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
