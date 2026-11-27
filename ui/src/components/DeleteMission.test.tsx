import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeleteMission } from './DeleteMission'
import { ApiError } from '../lib/api'

const mockDelete = vi.fn()
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiDelete: (...a: unknown[]) => mockDelete(...a),
}))

const onDeleted = vi.fn()
beforeEach(() => { mockDelete.mockReset(); onDeleted.mockReset() })

const open = () => userEvent.click(screen.getByRole('button', { name: /^Delete/ }))
const confirmBtn = () => screen.getAllByRole('button', { name: 'Delete' }).at(-1)!

describe('DeleteMission', () => {
  it('names the mission and sends exactly one DELETE to the encoded URL on confirm', async () => {
    mockDelete.mockResolvedValue(undefined)
    render(<DeleteMission name="a/b c" onDeleted={onDeleted} />)
    await open()
    expect(screen.getByRole('dialog', { name: 'Delete a/b c?' })).toBeInTheDocument()
    expect(screen.getByText(/cleaned up according to its cleanup policy/)).toBeInTheDocument()
    await userEvent.click(confirmBtn())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(mockDelete).toHaveBeenCalledTimes(1)
    expect(mockDelete.mock.calls[0][0]).toBe('/api/missions/a%2Fb%20c')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('cancel and Escape send no request and return focus to the button', async () => {
    render(<DeleteMission name="m1" onDeleted={onDeleted} />)
    const trigger = screen.getByRole('button', { name: /^Delete/ })
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await open()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(mockDelete).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the message on 409', async () => {
    mockDelete.mockRejectedValue(new ApiError(409, 'mission is still active'))
    render(<DeleteMission name="m1" onDeleted={onDeleted} />)
    await open()
    await userEvent.click(confirmBtn())
    expect(await screen.findByRole('alert')).toHaveTextContent('mission is still active')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the message on a network error', async () => {
    mockDelete.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<DeleteMission name="m1" onDeleted={onDeleted} />)
    await open()
    await userEvent.click(confirmBtn())
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('treats 404 as already deleted', async () => {
    mockDelete.mockRejectedValue(new ApiError(404, 'not found'))
    render(<DeleteMission name="m1" onDeleted={onDeleted} />)
    await open()
    await userEvent.click(confirmBtn())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sends one request on a double click', async () => {
    mockDelete.mockImplementation(() => new Promise(r => setTimeout(r, 20)))
    render(<DeleteMission name="m1" onDeleted={onDeleted} />)
    await open()
    await userEvent.dblClick(confirmBtn())
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(mockDelete).toHaveBeenCalledTimes(1)
  })
})
