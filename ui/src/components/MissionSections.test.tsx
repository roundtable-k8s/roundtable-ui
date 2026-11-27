import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MissionResults } from './MissionSections'
import { ApiError } from '../lib/api'

const mockApiGet = vi.fn()
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiGet: (...a: unknown[]) => mockApiGet(...a),
}))

describe('MissionResults', () => {
  it('reads a 404 as no results stored yet', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'nope'))
    render(<MissionResults name="m1" />)
    expect(await screen.findByText('No results stored yet')).toBeInTheDocument()
  })

  it('shows a 500 whose message is "notfound" as an error', async () => {
    mockApiGet.mockRejectedValue(new ApiError(500, 'notfound'))
    render(<MissionResults name="m1" />)
    expect(await screen.findByText(/Could not load results: notfound/)).toBeInTheDocument()
    expect(screen.queryByText('No results stored yet')).toBeNull()
  })
})
