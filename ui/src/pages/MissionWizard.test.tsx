import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionWizard } from './MissionWizard'
import { apiPost } from '../lib/api'

vi.mock('../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn().mockResolvedValue({}) }))

describe('MissionWizard meta-mission', () => {
  it('submits without planner.knightRef when no planner knight is typed', async () => {
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    await user.type(screen.getByLabelText('Mission Name'), 'm1')
    await user.type(screen.getByLabelText('Objective'), 'do it')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByLabelText('Planner Knight (optional)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /dispatch/i }))
    const body = vi.mocked(apiPost).mock.calls[0][1] as any
    expect(body.metaMission).toBe(true)
    expect(body.planner.knightRef).toBeUndefined()
    expect(body.planner.maxChains).toBe(5)
  })
})

describe('MissionWizard accessibility', () => {
  it('labels every step-0 field and the knight rows', async () => {
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    for (const l of ['Mission Name', 'Objective', 'RoundTable Reference', 'Cost Budget (USD)', 'TTL (seconds)', 'Timeout (seconds)']) {
      expect(screen.getByLabelText(l)).toBeInTheDocument()
    }
    await user.type(screen.getByLabelText('Mission Name'), 'm1')
    await user.type(screen.getByLabelText('Objective'), 'do it')
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByLabelText('Knight name')).toBeInTheDocument()
    expect(screen.getByLabelText('Knight role')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /add knight/i }))
    await user.click(screen.getAllByRole('button', { name: 'Remove knight' })[0])
    expect(screen.queryByRole('button', { name: 'Remove knight' })).toBeNull()
  })
})

describe('MissionWizard validation', () => {
  it('cannot reach Review with an empty name, and posts nothing', async () => {
    vi.mocked(apiPost).mockClear()
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    await user.type(screen.getByLabelText('Objective'), 'do it')
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Advanced' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.queryByRole('button', { name: /dispatch/i })).toBeNull()
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('shows a message for a cleared TTL and blocks the steps after it', async () => {
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    await user.type(screen.getByLabelText('Mission Name'), 'm1')
    await user.type(screen.getByLabelText('Objective'), 'do it')
    await user.clear(screen.getByLabelText('TTL (seconds)'))
    expect(screen.getByText('TTL must be between 60 and 604800 seconds')).toBeInTheDocument()
    expect(screen.getByLabelText('TTL (seconds)')).toHaveAttribute('aria-describedby', 'wiz-err-ttl')
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled()
  })
})

describe('MissionWizard step indicator', () => {
  it('exposes the steps as a list and moves aria-current on Next', async () => {
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    const list = screen.getByRole('list', { name: 'Mission steps' })
    expect(list.querySelectorAll('li')).toHaveLength(4)
    expect(screen.getByRole('button', { name: /basics/i })).toHaveAttribute('aria-current', 'step')
    await user.type(screen.getByLabelText('Mission Name'), 'm1')
    await user.type(screen.getByLabelText('Objective'), 'do it')
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByRole('button', { name: /knights/i })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('button', { name: /basics/i })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('button', { name: /basics.*\(complete\)/i })).toBeInTheDocument()
  })

  it('explains a step blocked by an invalid earlier step', async () => {
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    await user.type(screen.getByLabelText('Objective'), 'do it')
    const review = screen.getByRole('button', { name: /review/i })
    expect(review).toBeDisabled()
    expect(review).toHaveAttribute('title', 'Fix the earlier step first')
    expect(review).toHaveAccessibleDescription('Fix the earlier step first')
    expect(screen.getByRole('button', { name: /basics.*\(has errors\)/i })).toBeInTheDocument()
  })
})

describe('MissionWizard knights error', () => {
  it('hides the knights error until touched, then links it via aria-describedby', async () => {
    const user = userEvent.setup()
    render(<MissionWizard onClose={() => {}} onCreated={() => {}} />)
    await user.type(screen.getByLabelText('Mission Name'), 'm1')
    await user.type(screen.getByLabelText('Objective'), 'do it')
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(document.getElementById('wiz-err-knights')).toBeNull()
    const input = screen.getByLabelText('Knight name')
    await user.type(input, 'a')
    await user.clear(input)
    expect(document.getElementById('wiz-err-knights')).not.toBeNull()
    expect(input.getAttribute('aria-describedby')).toContain('wiz-err-knights')
  })
})
