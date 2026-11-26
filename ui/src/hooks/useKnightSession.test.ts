import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithTimeout, SESSION_TIMEOUT_MS } from './useKnightSession'
import { apiFetch } from '../lib/api'

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }))
const mockFetch = vi.mocked(apiFetch)

function abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}

/** A fetch that never answers until its signal aborts. */
function hang() {
  mockFetch.mockImplementation((_url, init) => new Promise((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(abortError()))
  }))
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('fetchWithTimeout', () => {
  it('returns the response and clears the timer', async () => {
    const res = new Response('ok')
    mockFetch.mockResolvedValue(res)
    await expect(fetchWithTimeout('/x')).resolves.toBe(res)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes an abort signal to apiFetch', async () => {
    mockFetch.mockResolvedValue(new Response('ok'))
    await fetchWithTimeout('/x')
    expect(mockFetch).toHaveBeenCalledWith('/x', { signal: expect.any(AbortSignal) })
  })

  it('returns null when the timeout fires first', async () => {
    hang()
    const p = fetchWithTimeout('/x', 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(p).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the default timeout', async () => {
    hang()
    let done = false
    const p = fetchWithTimeout('/x').then((r) => { done = true; return r })
    await vi.advanceTimersByTimeAsync(SESSION_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBeNull()
  })

  it('rethrows other errors and clears the timer', async () => {
    mockFetch.mockRejectedValue(new TypeError('network down'))
    await expect(fetchWithTimeout('/x')).rejects.toThrow('network down')
    expect(vi.getTimerCount()).toBe(0)
  })
})
