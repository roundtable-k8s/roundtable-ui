import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { render, screen, fireEvent } from '@testing-library/react'
import { useCopyToClipboard, COPY_ERROR } from './useCopyToClipboard'
import { CopyButton } from '../components/ui'

let writeText: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})
afterEach(() => vi.useRealTimers())

describe('useCopyToClipboard', () => {
  it('flashes copied then resets', async () => {
    const { result } = renderHook(() => useCopyToClipboard(1000))
    let ok = false
    await act(async () => { ok = await result.current.copy('hi') })
    expect(ok).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hi')
    expect(result.current.copied).toBe(true)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.copied).toBe(false)
  })

  it('sets error when the write is rejected', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const { result } = renderHook(() => useCopyToClipboard())
    let ok = true
    await act(async () => { ok = await result.current.copy('hi') })
    expect(ok).toBe(false)
    expect(result.current.copied).toBe(false)
    expect(result.current.error).toBe(COPY_ERROR)
  })

  it('does not update state or leave timers after unmount', async () => {
    const { result, unmount } = renderHook(() => useCopyToClipboard())
    await act(async () => { await result.current.copy('hi') })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => { await result.current.copy('again') })
    expect(vi.getTimerCount()).toBe(0)
    expect(err).not.toHaveBeenCalled()
  })
})

describe('CopyButton', () => {
  it('shows Copied then the label again', async () => {
    render(<CopyButton text="x" label="Copy YAML" />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy YAML' })) })
    expect(screen.getByText('Copied')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) })
    expect(screen.getByText('Copy YAML')).toBeTruthy()
  })

  it('shows the error, or hands it to onError', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const { unmount } = render(<CopyButton text="x" />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(screen.getByText(COPY_ERROR)).toBeTruthy()
    unmount()
    const onError = vi.fn()
    render(<CopyButton text="x" onError={onError} />)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(onError).toHaveBeenCalledWith(COPY_ERROR)
    expect(screen.queryByText(COPY_ERROR)).toBeNull()
  })

  it('sizes the icon and names an icon-only button from its label', () => {
    const { container } = render(<CopyButton text="x" iconOnly iconClassName="w-3 h-3" />)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('w-3 h-3')
  })
})
