import { Activity, Cpu, DollarSign, MessageSquare, Wrench } from 'lucide-react'
import { formatCost, formatNumber } from '../../lib/format'
import { StatCard } from '../ui'
import type { KnightSessionStats } from '../../hooks/useKnightSession'

export function SessionStatsSection({ session }: { session: NonNullable<KnightSessionStats['session']> }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Activity className="w-4 h-4" />
        Session Stats
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<MessageSquare className="w-4 h-4" />}
          label="Messages"
          value={session.totalMessages}
          detail={`${session.userMessages} user / ${session.assistantMessages} assistant`}
        />
        <StatCard
          icon={<Wrench className="w-4 h-4" />}
          label="Tool Calls"
          value={session.toolCalls}
        />
        <StatCard
          icon={<Cpu className="w-4 h-4" />}
          label="Tokens"
          value={formatNumber(session.tokens.total)}
          detail={`${formatNumber(session.tokens.input)} in / ${formatNumber(session.tokens.output)} out`}
        />
        <StatCard
          icon={<DollarSign className="w-4 h-4" />}
          label="Total Cost"
          value={formatCost(session.cost)}
          color="text-roundtable-gold"
        />
      </div>
    </div>
  )
}
