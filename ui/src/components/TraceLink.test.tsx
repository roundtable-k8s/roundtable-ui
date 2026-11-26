import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TraceLink } from './TraceLink'
import { apiGet } from '../lib/api'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))
const id = '0af7651916cd43dd8448eb211c80319c'

describe('TraceLink', () => {
  beforeEach(() => vi.mocked(apiGet).mockReset())

  it('links to the trace in a new tab', async () => {
    vi.mocked(apiGet).mockResolvedValue({ fleetPrefix: 'x', traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    render(<TraceLink traceId={id} />)
    const a = await screen.findByRole('link', { name: /View trace/ })
    expect(a).toHaveAttribute('href', `https://t.example/trace/${id}`)
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('is hidden without a template or a trace id', async () => {
    vi.mocked(apiGet).mockResolvedValue({ fleetPrefix: 'x' })
    const { container } = render(<TraceLink traceId={id} />)
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/{traceId}' })
    const r2 = render(<TraceLink />)
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2))
    expect(r2.container).toBeEmptyDOMElement()
  })
})
