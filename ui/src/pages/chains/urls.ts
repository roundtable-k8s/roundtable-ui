import { CHAIN_LIST_LIMIT } from '../../lib/chainTotal'

/** Slow fallback poll, only while the live feed is disconnected. */
export const FALLBACK_POLL_MS = 30_000

/**
 * Templates, scheduled and standalone chains: everything that is not a run
 * copy. Run copies are summarised by /api/chain-groups and loaded per
 * template on expand (#275).
 */
export const CHAINS_LIST_URL = `/api/chains?copies=exclude&limit=${CHAIN_LIST_LIMIT}`
export const CHAIN_GROUPS_URL = '/api/chain-groups'
/** Run copies loaded per "load more". */
export const GROUP_PAGE_SIZE = 20
/** Run copy changes refresh the group counts at most this often. */
export const GROUP_REFRESH_MS = 3_000

export const chainDetailUrl = (name: string) => `/api/chains/${encodeURIComponent(name)}`
export const groupRunsUrl = (template: string, offset: number, limit: number) =>
  `/api/chains?template=${encodeURIComponent(template)}&offset=${offset}&limit=${limit}`
