import { Activity } from 'lucide-react'
import type { KnightCondition } from '../../hooks/useFleet'

export function ConditionsSection({ conditions }: { conditions: KnightCondition[] }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Activity className="w-4 h-4" />
        Conditions
      </h3>
      <div className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-roundtable-steel/50">
              <th className="text-left text-gray-500 font-medium px-3 py-2">Type</th>
              <th className="text-left text-gray-500 font-medium px-3 py-2">Status</th>
              <th className="text-left text-gray-500 font-medium px-3 py-2 hidden sm:table-cell">Reason</th>
            </tr>
          </thead>
          <tbody>
            {conditions.map((cond: KnightCondition, i: number) => {
              const statusColor =
                cond.status === 'True' ? 'text-green-400 bg-green-500/10 border-green-500/20' :
                cond.status === 'False' ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
              return (
                <tr key={cond.type} className={i < conditions.length - 1 ? 'border-b border-roundtable-steel/30' : ''}>
                  <td className="px-3 py-2 text-gray-200 font-medium">{cond.type}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full border ${statusColor}`}>{cond.status}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-400 font-mono hidden sm:table-cell">{cond.reason || cond.message || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
