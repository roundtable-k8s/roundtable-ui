import { Activity, DollarSign, BarChart2 } from 'lucide-react'
import type { Knight } from '../../hooks/useFleet'
import { StatCard } from '../ui'

export function PerformanceSection({ knightDetail }: { knightDetail: Knight }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <BarChart2 className="w-4 h-4" />
        Performance
      </h3>
      <div className="grid grid-cols-2 gap-3">
        {knightDetail.tasksCompleted != null && (
          <StatCard
            icon={<Activity className="w-4 h-4" />}
            label="Completed"
            value={knightDetail.tasksCompleted}
            color="text-green-400"
          />
        )}
        {knightDetail.tasksFailed != null && (
          <StatCard
            icon={<Activity className="w-4 h-4" />}
            label="Failed"
            value={knightDetail.tasksFailed}
            color="text-red-400"
          />
        )}
        {knightDetail.totalCost && (
          <StatCard
            icon={<DollarSign className="w-4 h-4" />}
            label="Total Cost"
            value={`$${knightDetail.totalCost}`}
            color="text-roundtable-gold"
          />
        )}
        {knightDetail.tasksCompleted != null && knightDetail.tasksFailed != null && (knightDetail.tasksCompleted + knightDetail.tasksFailed) > 0 && (
          <StatCard
            icon={<BarChart2 className="w-4 h-4" />}
            label="Success Rate"
            value={`${Math.round((knightDetail.tasksCompleted / (knightDetail.tasksCompleted + knightDetail.tasksFailed)) * 100)}%`}
            color="text-blue-400"
          />
        )}
      </div>
    </div>
  )
}
