import type { Chain } from '../lib/types'
import { tokensText } from '../lib/cost'
import { CostTag } from './CostTag'

/**
 * Cost and tokens per step of a chain run, with the run total (#270). Steps
 * without cost data show "—".
 */
export function RunCostTable({ chain }: { chain: Chain }) {
  const steps = chain.steps || []
  return (
    <table className="w-full text-xs mt-3" aria-label={`${chain.name} cost`}>
      <thead>
        <tr className="text-left text-gray-500">
          <th className="px-2 py-1 font-normal">Step</th>
          <th className="px-2 py-1 font-normal">Knight</th>
          <th className="px-2 py-1 font-normal text-right">Cost (USD)</th>
          <th className="px-2 py-1 font-normal text-right">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {steps.map(s => (
          <tr key={s.name} className="border-t border-roundtable-steel/30 text-gray-300">
            <td className="px-2 py-1">{s.name}</td>
            <td className="px-2 py-1 text-gray-400">{s.knight}</td>
            <td className="px-2 py-1 text-right"><CostTag costUSD={s.costUSD} notional={s.costNotional} className="justify-end" /></td>
            <td className="px-2 py-1 text-right text-gray-400">{tokensText(s.tokens)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-roundtable-steel text-white font-semibold">
          <td className="px-2 py-1" colSpan={2}>Total</td>
          <td className="px-2 py-1 text-right"><CostTag costUSD={chain.costUSD} notionalUSD={chain.notionalCostUSD} className="justify-end" /></td>
          <td className="px-2 py-1 text-right">{tokensText(chain.tokens)}</td>
        </tr>
      </tfoot>
    </table>
  )
}
