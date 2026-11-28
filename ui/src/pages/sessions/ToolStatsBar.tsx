// Tool Stats bar (tools view)
export function ToolStatsBar({ toolStats }: { toolStats: { total: number; byName: [string, number][] } }) {
  return (
    <>
    {toolStats.total > 0 && (
      <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-400 mb-2">Tool Usage ({toolStats.total} calls)</h3>
        <div className="flex flex-wrap gap-2">
          {toolStats.byName.slice(0, 10).map(([name, count]) => (
            <span key={name} className="text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-1 rounded-full font-mono">
              {name} <span className="text-gray-500">×{count}</span>
            </span>
          ))}
        </div>
      </div>
    )}
    </>
  )
}
