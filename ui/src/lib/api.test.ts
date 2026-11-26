import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError, DEFAULT_TIMEOUT_MS, apiDelete, apiFetch, apiGet, apiGetText, apiPost, apiPut } from './api'

const fetchMock = vi.fn()

function res(status: number, body: string, statusText = ''): Response {
  return new Response(body, { status, statusText })
}

beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
afterEach(() => { vi.unstubAllGlobals() })

describe('error parsing', () => {
  it('reads message and field from a JSON {error, field} body', async () => {
    fetchMock.mockResolvedValue(res(400, JSON.stringify({ error: 'bad cron', field: 'spec.source.schedule.cron' })))
    const err = await apiGet('/x').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(400)
    expect(err.message).toBe('bad cron')
    expect(err.field).toBe('spec.source.schedule.cron')
  })

  it('has no field when the JSON body names none', async () => {
    fetchMock.mockResolvedValue(res(500, JSON.stringify({ error: 'boom' })))
    const err = await apiGet('/x').catch((e) => e)
    expect(err.message).toBe('boom')
    expect(err.field).toBeUndefined()
  })

  it('uses a plain-text body as the message, truncated at 300 chars', async () => {
    fetchMock.mockResolvedValue(res(400, 'TTL must be 60-604800 seconds'))
    expect((await apiGet('/x').catch((e) => e)).message).toBe('TTL must be 60-604800 seconds')

    fetchMock.mockResolvedValue(res(502, 'x'.repeat(500)))
    expect((await apiGet('/x').catch((e) => e)).message).toBe('x'.repeat(300))
  })

  it('truncates a JSON body without an error string', async () => {
    const body = JSON.stringify({ detail: 'y'.repeat(500) })
    fetchMock.mockResolvedValue(res(500, body))
    expect((await apiGet('/x').catch((e) => e)).message).toBe(body.slice(0, 300))
  })

  it('falls back to the status line for an empty body', async () => {
    fetchMock.mockResolvedValue(res(503, '', 'Service Unavailable'))
    const err = await apiGet('/x').catch((e) => e)
    expect(err.message).toBe('503 Service Unavailable')
    expect(err.status).toBe(503)
  })

  it('does not throw for 2xx and parses the JSON', async () => {
    fetchMock.mockResolvedValue(res(200, '{"a":1}'))
    expect(await apiGet('/x')).toEqual({ a: 1 })
  })
})

describe('request shape', () => {
  it('apiDelete sends no body and no content-type, and ignores the response', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(apiDelete('/x/1')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/x/1')
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).has('Content-Type')).toBe(false)
  })

  it('apiDelete throws an ApiError on failure', async () => {
    fetchMock.mockResolvedValue(res(404, JSON.stringify({ error: 'gone' })))
    await expect(apiDelete('/x/1')).rejects.toMatchObject({ status: 404, message: 'gone' })
  })

  it('sets JSON content-type only when there is a body', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(200, '{}')))
    await apiPost('/x', { a: 1 })
    const [, post] = fetchMock.mock.calls[0]
    expect(post.method).toBe('POST')
    expect(post.body).toBe('{"a":1}')
    expect(new Headers(post.headers).get('Content-Type')).toBe('application/json')

    await apiGet('/x')
    expect(new Headers(fetchMock.mock.calls[1][1].headers).has('Content-Type')).toBe(false)
  })

  it('sends extra headers given to apiPost', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(res(200, '{}')))
    await apiPost('/x', { a: 1 }, { headers: { 'Idempotency-Key': 'abc' } })
    const h = new Headers(fetchMock.mock.calls[0][1].headers)
    expect(h.get('Idempotency-Key')).toBe('abc')
    expect(h.get('Content-Type')).toBe('application/json')
  })

  it('keeps a caller-provided content-type', async () => {
    fetchMock.mockResolvedValue(res(200, ''))
    await apiFetch('/x', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'text/plain' } })
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Content-Type')).toBe('text/plain')
  })
})

/** A fetch that never answers until its signal aborts, then rejects with the signal's reason. */
function hang() {
  fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => {
    if (init.signal?.aborted) return rej(init.signal.reason)
    init.signal?.addEventListener('abort', () => rej(init.signal?.reason))
  }))
}

describe('timeouts', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('rejects a request that never answers after the default 30 s', async () => {
    hang()
    let settled = false
    const p = apiGet('/api/fleet?ns=a').catch((e) => { settled = true; throw e })
    const assertion = expect(p).rejects.toMatchObject({ name: 'ApiError', status: 0, message: 'Request timed out after 30 s: GET /api/fleet' })
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours a per-call timeoutMs and names the method', async () => {
    hang()
    const p = apiPost('/api/x', {}, { timeoutMs: 1500 })
    const assertion = expect(p).rejects.toMatchObject({ status: 0, message: 'Request timed out after 1.5 s: POST /api/x' })
    await vi.advanceTimersByTimeAsync(1500)
    await assertion
  })

  it('timeoutMs 0 disables the timeout', async () => {
    hang()
    let settled = false
    apiGet('/x', { timeoutMs: 0 }).catch(() => { settled = true })
    await vi.advanceTimersByTimeAsync(10 * DEFAULT_TIMEOUT_MS)
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer once headers arrive', async () => {
    fetchMock.mockResolvedValue(res(200, '{"ok":true}'))
    await expect(apiGet('/x')).resolves.toEqual({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a caller abort rejects with AbortError, not a timeout, and clears the timer', async () => {
    hang()
    const ac = new AbortController()
    const p = apiGet('/x', { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an already-aborted signal rejects without a timeout error', async () => {
    hang()
    const ac = new AbortController()
    ac.abort()
    await expect(apiGet('/x', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts a POST, PUT, DELETE and text GET through the caller signal', async () => {
    hang()
    const ac = new AbortController()
    const calls = [
      apiPost('/x', {}, { signal: ac.signal }),
      apiPut('/x', {}, { signal: ac.signal }),
      apiDelete('/x', { signal: ac.signal }),
      apiGetText('/x', { signal: ac.signal }),
    ]
    ac.abort()
    for (const c of calls) await expect(c).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes the caller signal and not the timeoutMs option to fetch', async () => {
    fetchMock.mockResolvedValue(res(200, '{}'))
    await apiGet('/x', { timeoutMs: 5, headers: { 'X-A': '1' } })
    const init = fetchMock.mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init).not.toHaveProperty('timeoutMs')
    expect(new Headers(init.headers).get('X-A')).toBe('1')
  })
})

describe('non-JSON answers', () => {
  it('turns a 200 HTML page into a readable ApiError', async () => {
    fetchMock.mockResolvedValue(res(200, '<!doctype html><html></html>'))
    const err = await apiGet('/api/fleet?x=1').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect(err.status).toBe(200)
    expect(err.message).toBe('The server did not answer with JSON for /api/fleet (the session may have expired or the API is out of date)')
  })

  it('an empty 2xx body is an error for apiGet', async () => {
    fetchMock.mockResolvedValue(res(200, ''))
    await expect(apiGet('/x')).rejects.toMatchObject({ status: 200, message: expect.stringContaining('did not answer with JSON for /x') })
  })

  it('apiPost and apiPut return null for an empty 204 body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(apiPost('/x', {})).resolves.toBeNull()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(apiPut('/x', {})).resolves.toBeNull()
  })

  it('apiPost still rejects non-JSON 2xx text', async () => {
    fetchMock.mockResolvedValue(res(200, 'OK'))
    await expect(apiPost('/x', {})).rejects.toMatchObject({ status: 200, message: expect.stringContaining('did not answer with JSON') })
  })

  it('apiGetText returns the text and honours an error body', async () => {
    fetchMock.mockResolvedValue(res(200, 'log line'))
    await expect(apiGetText('/x')).resolves.toBe('log line')
    fetchMock.mockResolvedValue(res(404, JSON.stringify({ error: 'no pod' })))
    await expect(apiGetText('/x')).rejects.toMatchObject({ status: 404, message: 'no pod' })
  })
})

describe('401 and 403 without a body message', () => {
  it('say not signed in or not allowed and keep the status', async () => {
    fetchMock.mockResolvedValue(res(401, '', 'Unauthorized'))
    const err = await apiGet('/x').catch((e) => e)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Not signed in or not allowed (401 Unauthorized)')

    fetchMock.mockResolvedValue(res(403, ''))
    const forbidden = await apiGet('/x').catch((e) => e)
    expect(forbidden.status).toBe(403)
    expect(forbidden.message).toContain('Not signed in or not allowed')
  })

  it('keep the server message when the body has one', async () => {
    fetchMock.mockResolvedValue(res(403, JSON.stringify({ error: 'namespace forbidden' }), 'Forbidden'))
    expect((await apiGet('/x').catch((e) => e)).message).toBe('namespace forbidden')
  })

  it('other statuses still show the status line', async () => {
    fetchMock.mockResolvedValue(res(500, '', 'Internal Server Error'))
    expect((await apiGet('/x').catch((e) => e)).message).toBe('500 Internal Server Error')
  })
})
