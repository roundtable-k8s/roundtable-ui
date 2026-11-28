import { useEffect, useRef } from 'react'
import type { Chain } from '../../lib/types'
import { usePolledFetch } from '../../hooks/usePolledFetch'
import { chainDetailUrl } from './urls'

/**
 * The full chain for an expanded card. List items are slim (no step detail),
 * so the chain is fetched from /api/chains/{name} when expanded and again
 * whenever the slim list item changes. A WS push carries the full chain and
 * is used as is.
 */
export function useChainDetail(chain: Chain, expanded: boolean): { view: Chain | null; error: string } {
  const { data: detail, error, refresh } = usePolledFetch<Chain | null>(
    expanded && chain.slim ? chainDetailUrl(chain.name) : null, 0, null)
  // Refetch when the slim list item moves on (phase/step), keyed on those
  // rather than the object: the list poll hands over a new object each time.
  const seen = useRef(`${chain.phase}/${chain.currentStep}`)
  useEffect(() => {
    const key = `${chain.phase}/${chain.currentStep}`
    if (seen.current === key) return
    seen.current = key
    if (expanded && chain.slim) void refresh()
  }, [chain.phase, chain.currentStep, chain.slim, expanded, refresh])
  if (!chain.slim) return { view: chain, error: '' }
  return { view: detail && detail.name === chain.name ? detail : null, error: error ?? '' }
}
