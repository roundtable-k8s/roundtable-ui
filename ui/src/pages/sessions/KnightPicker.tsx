import { TreePine, Wrench, MessageSquare, Search } from 'lucide-react'
import type { Knight } from '../../hooks/useFleet'

type View = 'timeline' | 'tree' | 'tools'

interface Props {
  knights: Knight[]
  filteredKnights: Knight[]
  knightConfig: Record<string, { emoji?: string }>
  selectedKnight: string
  onSelectKnight: (name: string) => void
  knightSearchQuery: string
  onKnightSearchChange: (q: string) => void
  view: View
  onViewChange: (v: View) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  filterType: string
  onFilterTypeChange: (t: string) => void
}

// Knight picker with search + view tabs
export function KnightPicker(p: Props) {
  const { knights, filteredKnights, knightConfig, selectedKnight, view } = p
  return (
    <div className="flex flex-wrap items-center gap-4 mb-6">
      <div className="relative">
        <select aria-label="Knight" value={selectedKnight} onChange={e => p.onSelectKnight(e.target.value)}
          className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-4 py-2 text-white pr-8 appearance-none min-w-[200px]">
          {(filteredKnights.some(k => k.name === selectedKnight) ? filteredKnights : [...knights.filter(k => k.name === selectedKnight), ...filteredKnights]).map(k => {
            const kc = knightConfig[k.name]
            const statusIcon = k.status === 'online' ? '🟢' : k.status === 'busy' ? '🟡' : '🔴'
            return <option key={k.name} value={k.name}>{kc?.emoji || '🤖'} {k.name} {statusIcon}</option>
          })}
        </select>
      </div>

      <div className="relative flex-1 max-w-xs">
        <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
        <input
          type="text"
          value={p.knightSearchQuery}
          onChange={e => p.onKnightSearchChange(e.target.value)}
          aria-label="Filter knights"
          placeholder="Filter knights by name or domain..."
          className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500"
        />
      </div>

      <div className="flex rounded-lg border border-roundtable-steel overflow-hidden">
        {(['timeline', 'tree', 'tools'] as const).map(v => (
          <button key={v} onClick={() => p.onViewChange(v)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              view === v ? 'bg-roundtable-gold/20 text-roundtable-gold' : 'bg-roundtable-slate text-gray-400 hover:text-white'
            }`}>
            {v === 'timeline' && <><MessageSquare className="w-4 h-4 inline mr-1.5" />Timeline</>}
            {v === 'tree' && <><TreePine className="w-4 h-4 inline mr-1.5" />Tree</>}
            {v === 'tools' && <><Wrench className="w-4 h-4 inline mr-1.5" />Tools</>}
          </button>
        ))}
      </div>

      {view !== 'tree' && (
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
            <input type="text" value={p.searchQuery} onChange={e => p.onSearchChange(e.target.value)}
              aria-label="Search entries"
              placeholder="Search entries..."
              className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500" />
          </div>
          <select aria-label="Filter by entry type" value={p.filterType} onChange={e => p.onFilterTypeChange(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-sm text-white">
            <option value="">All Types</option>
            <option value="user">📨 User</option>
            <option value="assistant">🤖 Assistant</option>
            <option value="tool_use">🔧 Tool Use</option>
            <option value="tool_result">📋 Tool Result</option>
            <option value="thinking">🧠 Thinking</option>
          </select>
        </div>
      )}
    </div>
  )
}
