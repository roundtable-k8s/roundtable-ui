import { useState, useEffect, useMemo } from 'react'
import { Scroll, Clock } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { getKnightConfig } from '../lib/knights'
import { useFleet } from '../hooks/useFleet'
import { useWebSocket } from '../hooks/useWebSocket'
import { tableForKnight, taskRows, type TableInfo } from '../lib/tables'
import { useToast } from '../components/Toast'
import { PageHeader, EmptyState, ErrorBanner } from '../components/ui'
import { formatTimestamp } from '../lib/format'

export function TasksPage() {
  const { knights, error: fleetError } = useFleet(60000)
  const { addToast } = useToast()
  const [knight, setKnight] = useState('')
  const [task, setTask] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const [results, setResults] = useState<Array<{
    taskId: string
    knight: string
    table: string
    task: string
    status: string
    timestamp: string
  }>>([])
  const [fleetPrefix, setFleetPrefix] = useState('fleet-a')
  // Every RoundTable the API covers (#239)
  const [tables, setTables] = useState<TableInfo[]>([])
  // Dispatch table picked by the user; '' = the knight's own table
  const [tableChoice, setTableChoice] = useState('')
  // History filter; '' = all tables
  const [tableFilter, setTableFilter] = useState('')
  const { events } = useWebSocket()

  // Default to the first knight once the fleet loads
  useEffect(() => {
    if (!knight && knights.length > 0) setKnight(knights[0].name)
  }, [knight, knights])

  const selected = knights.find((k) => k.name === knight)
  const config = getKnightConfig(knight)
  const domain = selected?.domain ?? ''
  const ownTable = tableForKnight(selected?.natsPrefix, tables)
  const dispatchTable = tables.find((t) => t.name === tableChoice) ?? ownTable ?? tables[0]
  const subjectPrefix = dispatchTable?.prefix ?? fleetPrefix
  const rows = useMemo(() => taskRows(events, tables, tableFilter), [events, tables, tableFilter])

  // Fetch fleet configuration from backend (#60)
  useEffect(() => {
    apiGet<{ fleetPrefix?: string }>('/api/config')
      .then((data) => {
        if (data.fleetPrefix) setFleetPrefix(data.fleetPrefix)
      })
      .catch(() => {})
    apiGet<{ tables?: TableInfo[] }>('/api/tasks')
      .then((data) => setTables(data.tables ?? []))
      .catch(() => {})
  }, [])

  const selectKnight = (name: string) => {
    setKnight(name)
    setTableChoice('') // follow the new knight's own table
  }

  const dispatch = async () => {
    if (!task.trim() || !selected) return
    setDispatching(true)

    try {
      const data = await apiPost<{ task_id: string; table?: string }>('/api/tasks/dispatch', {
        knight,
        domain: selected.domain,
        task,
        ...(dispatchTable ? { table: dispatchTable.name } : {}),
      })
      setResults((prev) => [{
        taskId: data.task_id,
        knight,
        table: data.table ?? dispatchTable?.name ?? '',
        task,
        status: 'dispatched',
        timestamp: new Date().toISOString(),
      }, ...prev])
      setTask('')
    } catch (e) {
      addToast(`Dispatch failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error')
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div>
      <PageHeader icon={Scroll} title="Dispatch" />

      {fleetError && knights.length === 0 && (
        <div className="mb-6">
          <ErrorBanner>Cannot load the knight roster: {fleetError}</ErrorBanner>
        </div>
      )}

      {/* Dispatch form */}
      <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-6 mb-8">
        <div className="flex gap-4 mb-4">
          <div className="w-48">
            <label className="text-sm text-gray-400 mb-2 block">Knight</label>
            <select
              value={knight}
              onChange={(e) => selectKnight(e.target.value)}
              className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white"
            >
              {knights.length === 0 && <option value="">Loading fleet…</option>}
              {knights.map((k) => (
                <option key={k.name} value={k.name}>
                  {getKnightConfig(k.name).emoji} {k.name} ({k.domain})
                </option>
              ))}
            </select>
          </div>
          {tables.length > 1 && (
            <div className="w-48">
              <label htmlFor="dispatch-table" className="text-sm text-gray-400 mb-2 block">Table</label>
              <select
                id="dispatch-table"
                value={dispatchTable?.name ?? ''}
                onChange={(e) => setTableChoice(e.target.value)}
                className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white"
              >
                {tables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}{t.name === ownTable?.name ? ' (own)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex-1">
            <label className="text-sm text-gray-400 mb-2 block">Quest</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && dispatch()}
                placeholder={knight ? `Send a quest to ${config.emoji} ${knight} (${domain})...` : 'Waiting for fleet…'}
                className="flex-1 bg-roundtable-navy border border-roundtable-steel rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-roundtable-gold/50 focus:outline-none"
              />
              <button
                onClick={dispatch}
                disabled={dispatching || !task.trim() || !selected}
                className="px-6 py-2 bg-roundtable-gold/20 hover:bg-roundtable-gold/30 border border-roundtable-gold/30 rounded-lg text-roundtable-gold font-medium transition-colors disabled:opacity-50"
              >
                {dispatching ? '...' : 'Dispatch'}
              </button>
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Dispatching to domain: <span className="text-roundtable-gold font-mono">{domain || '—'}</span> via NATS subject: <span className="font-mono">{subjectPrefix}.tasks.{domain || '*'}.*</span>
          {dispatchTable && <> on table <span className="text-roundtable-gold font-mono">{dispatchTable.name}</span></>}
        </p>
      </div>

      {/* Recent dispatches */}
      <h2 className="text-xl font-bold text-white mb-4">Recent Dispatches</h2>
      <div className="space-y-3 mb-10">
        {results.length === 0 && (
          <EmptyState title="No quests dispatched yet. Send one above!" />
        )}
        {results.map((r) => {
          const kc = getKnightConfig(r.knight)
          return (
            <div
              key={r.taskId}
              className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span>{kc.emoji}</span>
                  <span className="font-medium text-white capitalize">{r.knight}</span>
                  {r.table && <TableBadge table={r.table} />}
                  <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded">
                    {r.status}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-gray-500 text-xs">
                  <Clock className="w-3 h-3" />
                  {formatTimestamp(r.timestamp)}
                </div>
              </div>
              <p className="text-gray-300 text-sm">{r.task}</p>
              <p className="text-gray-500 text-xs mt-1 font-mono">{r.taskId}</p>
            </div>
          )
        })}
      </div>

      {/* Task history across every table (#239) */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">Task History</h2>
        {tables.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor="table-filter" className="text-sm text-gray-400">Table</label>
            <select
              id="table-filter"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1 text-white text-sm"
            >
              <option value="">All tables</option>
              {tables.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="space-y-2" data-testid="task-history">
        {rows.length === 0 && <EmptyState title="No tasks seen yet." />}
        {rows.map((r) => (
          <div
            key={r.key}
            data-testid="task-row"
            className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={
                  r.type === 'task'
                    ? 'text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded'
                    : r.success
                      ? 'text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded'
                      : 'text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded'
                }>
                  {r.type === 'task' ? 'task' : r.success ? 'done' : 'failed'}
                </span>
                {r.knight && <span className="font-medium text-white capitalize">{r.knight}</span>}
                {r.table && <TableBadge table={r.table} />}
                <span className="text-gray-500 text-xs font-mono truncate">{r.taskId}</span>
              </div>
              <div className="flex items-center gap-1 text-gray-500 text-xs shrink-0">
                <Clock className="w-3 h-3" />
                {formatTimestamp(r.timestamp)}
              </div>
            </div>
            {r.text && <p className="text-gray-300 text-sm mt-1 line-clamp-2">{r.text}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

function TableBadge({ table }: { table: string }) {
  return (
    <span data-testid="table-badge" className="text-xs bg-roundtable-gold/10 text-roundtable-gold px-2 py-0.5 rounded font-mono">
      {table}
    </span>
  )
}
