import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TraceLink } from './TraceLink'
import { apiGet } from '../lib/api'
import { resetConfigCache } from '../hooks/useConfig'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))
const id = '0af7651916cd43dd8448eb211c80319c'

describe('TraceLink', () => {
  beforeEach(() => { vi.mocked(apiGet).mockReset(); resetConfigCache() })

  it('links to the trace in a new tab', async () => {
    vi.mocked(apiGet).mockResolvedValue({ fleetPrefix: 'x', traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    render(<TraceLink traceId={id} />)
    const a = await screen.findByRole('link', { name: /View trace/ })
    expect(a).toHaveAttribute('href', `https://t.example/trace/${id}`)
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('uses the small text size by default and xs when asked', async () => {
    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    const { unmount } = render(<TraceLink traceId={id} />)
    expect(await screen.findByRole('link', { name: /View trace/ })).toHaveClass('text-sm')
    unmount()
    render(<TraceLink traceId={id} size="xs" />)
    const a = await screen.findByRole('link', { name: /View trace/ })
    expect(a).toHaveClass('text-xs')
    expect(a).not.toHaveClass('text-sm')
  })

  it('is hidden without a template or a trace id', async () => {
    vi.mocked(apiGet).mockResolvedValue({ fleetPrefix: 'x' })
    const { container } = render(<TraceLink traceId={id} />)
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/{traceId}' })
    const r2 = render(<TraceLink />)
    expect(r2.container).toBeEmptyDOMElement()
  })

  it('shares one /api/config request across many links', async () => {
    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    render(<><TraceLink traceId={id} /><TraceLink traceId={id} /><TraceLink traceId={id} /></>)
    expect(await screen.findAllByRole('link', { name: /View trace/ })).toHaveLength(3)
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed request on a later mount', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('down'))
    const first = render(<TraceLink traceId={id} />)
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(first.container).toBeEmptyDOMElement()
    first.unmount()

    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    render(<TraceLink traceId={id} />)
    expect(await screen.findByRole('link', { name: /View trace/ })).toBeInTheDocument()
    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
