import { costText, NOTIONAL_HINT, notionalShare } from '../lib/cost'

/**
 * A cost with its notional marker (#270): "$0.75 notional" when all of it is
 * subscription-billed, "$1.20 (incl. $0.25 notional)" when part is, and "—"
 * without cost data. Pass `notional` for a single step, `notionalUSD` for a
 * total.
 */
export function CostTag({ costUSD, notional, notionalUSD, className = '' }: {
  costUSD?: string | null
  notional?: boolean
  notionalUSD?: string | null
  className?: string
}) {
  const text = costText(costUSD)
  const share = text === '—' ? 'none' : notional ? 'all' : notionalShare(costUSD, notionalUSD)
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} title={share === 'none' ? undefined : NOTIONAL_HINT}>
      <span className={share === 'all' ? 'italic' : undefined}>{text}</span>
      {share === 'all' && (
        <span className="text-[10px] uppercase tracking-wide px-1 rounded border border-sky-500/30 bg-sky-500/10 text-sky-300">notional</span>
      )}
      {share === 'partial' && (
        <span className="text-[10px] text-sky-300">(incl. {costText(notionalUSD)} notional)</span>
      )}
    </span>
  )
}
