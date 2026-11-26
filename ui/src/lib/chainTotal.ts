import { apiFetch } from './api'

/** Page size the Chains and Dashboard lists ask for (the API maximum). */
export const CHAIN_LIST_LIMIT = 500

/**
 * Number of chains matching listUrl, read from X-Total-Count of a one-item
 * page. Only call when the list came back full: null when unknown.
 */
export async function fetchChainTotal(listUrl: string): Promise<number | null> {
  try {
    const res = await apiFetch(listUrl.replace(/([?&])limit=\d+/, '$1limit=1'))
    if (!res.ok) return null
    const n = Number(res.headers.get('X-Total-Count'))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** "showing 500 of N" when the list is cut short, else null. */
export function truncationNote(shown: number, total: number | null): string | null {
  return total !== null && total > shown ? `showing ${shown} of ${total}` : null
}
