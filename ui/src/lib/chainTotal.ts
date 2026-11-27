/** Page size the Chains and Dashboard lists ask for (the API maximum). */
export const CHAIN_LIST_LIMIT = 500

/** A total remembered together with the list URL it belongs to. */
export interface KeyedTotal { url: string; total: number | null }

/** The stored total only when it was read for url (a table switch must not show the old one). */
export function totalFor(stored: KeyedTotal | null, url: string): number | null {
  return stored && stored.url === url ? stored.total : null
}

/** "showing 500 of N" when the list is cut short, else null. */
export function truncationNote(shown: number, total: number | null): string | null {
  return total !== null && total > shown ? `showing ${shown} of ${total}` : null
}
