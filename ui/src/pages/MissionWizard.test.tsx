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
