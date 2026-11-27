/**
 * Typed JSON API client. Authentication happens upstream — forward auth at
 * the ingress injects the bearer token — so the browser never handles
 * credentials. The backend still enforces DASHBOARD_API_KEY for direct
 * (non-proxied) API access.
 *
 * Every request has a timeout (DEFAULT_TIMEOUT_MS, or `timeoutMs` per call;
 * 0 disables it) and can be cancelled through `signal`.
 */

/** Default time a request may wait for response headers before it fails. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** RequestInit plus the client's own `timeoutMs` option (0 disables the timeout). */
export type ApiRequestInit = RequestInit & { timeoutMs?: number }

export class ApiError extends Error {
  readonly status: number
  /** The request field a 400 names, e.g. the gateway's "spec.source.schedule.cron". */
  readonly field?: string

  constructor(status: number, message: string, field?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.field = field
  }
}

/** The path of a URL without its query string or fragment, for messages. */
function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0]
}

function describeSeconds(ms: number): string {
  return `${+(ms / 1000).toFixed(1)} s`
}

async function toApiError(res: Response): Promise<ApiError> {
  // The Go API mixes JSON {"error": ...} bodies with plain-text http.Error
  // messages (e.g. "TTL must be 60-604800 seconds") — surface both.
  let message = ''
  let field: string | undefined
  try {
    const body = (await res.text()).trim()
    if (body) {
      try {
        const parsed = JSON.parse(body)
        message = typeof parsed?.error === 'string' ? parsed.error : body.slice(0, 300)
        if (typeof parsed?.field === 'string' && parsed.field) field = parsed.field
      } catch {
        message = body.slice(0, 300)
      }
    }
  } catch {
    // unreadable body — fall back to the status below
  }
  if (!message) {
    message = res.status === 401 || res.status === 403
      ? `Not signed in or not allowed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`
      : `${res.status} ${res.statusText}`
  }
  return new ApiError(res.status, message, field)
}

/**
 * Low-level fetch wrapper: sets JSON Content-Type when a body is present,
 * applies the timeout and links `signal` to the request, and returns the raw
 * Response. The timeout covers the wait for response headers. Prefer
 * apiGet/apiPost/apiPut/apiDelete.
 *
 * A timeout rejects with ApiError status 0; a caller abort rejects with the
 * AbortError from fetch, unchanged.
 */
export async function apiFetch(url: string, options?: ApiRequestInit): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...init } = options ?? {}
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) controller.abort(callerSignal.reason)
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  let timedOut = false
  const timer = timeoutMs > 0
    ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    : undefined

  let failed = false
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal })
  } catch (e) {
    failed = true
    if (timedOut) {
      const method = (init.method ?? 'GET').toUpperCase()
      throw new ApiError(0, `Request timed out after ${describeSeconds(timeoutMs)}: ${method} ${pathOf(url)}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
    // On success keep the listener: aborting the caller's signal must still cancel the body read.
    if (failed) callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * Read a 2xx body as JSON. A body that is not JSON (an expired login page,
 * a proxy error page, an unknown route answered by the SPA) gets a readable
 * ApiError instead of a raw SyntaxError. An empty body is `null` when
 * `allowEmpty` is set (204-style answers) and an error otherwise.
 */
async function readJson<T>(res: Response, url: string, allowEmpty = false): Promise<T> {
  const text = await res.text()
  if (allowEmpty && text.trim() === '') return null as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(
      res.status,
      `The server did not answer with JSON for ${pathOf(url)} (the session may have expired or the API is out of date)`,
    )
  }
}

/** GET url and parse JSON. Throws ApiError on non-2xx. */
export async function apiGet<T>(url: string, init?: ApiRequestInit): Promise<T> {
  const res = await apiFetch(url, init)
  if (!res.ok) throw await toApiError(res)
  return readJson<T>(res, url)
}

/**
 * GET a list and also read X-Total-Count from the same response. total is
 * null when the header is absent or not a positive number.
 */
export async function apiGetWithTotal<T>(url: string, init?: ApiRequestInit): Promise<{ items: T; total: number | null }> {
  const res = await apiFetch(url, init)
  if (!res.ok) throw await toApiError(res)
  const items = await readJson<T>(res, url)
  const n = Number(res.headers.get('X-Total-Count'))
  return { items, total: res.headers.get('X-Total-Count') !== null && Number.isFinite(n) && n > 0 ? n : null }
}

/** GET url and return the body as text. Throws ApiError on non-2xx. */
export async function apiGetText(url: string, init?: ApiRequestInit): Promise<string> {
  const res = await apiFetch(url, init)
  if (!res.ok) throw await toApiError(res)
  return res.text()
}

export interface ApiWriteOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Overrides DEFAULT_TIMEOUT_MS; 0 disables the timeout. */
  timeoutMs?: number
}

/** POST a JSON body and parse the JSON response. Throws ApiError on non-2xx. */
export async function apiPost<T>(url: string, body: unknown, opts?: ApiWriteOptions): Promise<T> {
  const res = await apiFetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: opts?.headers,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
  })
  if (!res.ok) throw await toApiError(res)
  return readJson<T>(res, url, true)
}

/** PUT a JSON body and parse the JSON response. Throws ApiError on non-2xx. */
export async function apiPut<T>(url: string, body: unknown, opts?: ApiWriteOptions): Promise<T> {
  const res = await apiFetch(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: opts?.headers,
    signal: opts?.signal,
    timeoutMs: opts?.timeoutMs,
  })
  if (!res.ok) throw await toApiError(res)
  return readJson<T>(res, url, true)
}

/** DELETE url; the response body, if any, is ignored. Throws ApiError on non-2xx. */
export async function apiDelete(url: string, opts?: Pick<ApiWriteOptions, 'signal' | 'timeoutMs'>): Promise<void> {
  const res = await apiFetch(url, { method: 'DELETE', signal: opts?.signal, timeoutMs: opts?.timeoutMs })
  if (!res.ok) throw await toApiError(res)
}
