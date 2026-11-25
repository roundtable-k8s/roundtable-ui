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
    await user.type(screen.getByPlaceholderText('e.g. code-review-sprint'), 'm1')
    await user.type(screen.getByPlaceholderText('Describe the mission objective...'), 'do it')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(screen.getByPlaceholderText('table planner (default)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /next/i }))
    await user.click(screen.getByRole('button', { name: /dispatch/i }))
    const body = vi.mocked(apiPost).mock.calls[0][1] as any
    expect(body.metaMission).toBe(true)
    expect(body.planner.knightRef).toBeUndefined()
    expect(body.planner.maxChains).toBe(5)
  })
})
