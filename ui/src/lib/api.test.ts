import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiError, apiDelete, apiFetch, apiGet, apiPost } from './api'

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
