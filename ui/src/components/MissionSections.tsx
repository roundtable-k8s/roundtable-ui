import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Users, Link2, CheckCircle, XCircle, Zap, Hash } from 'lucide-react'
import { apiGet, ApiError } from '../lib/api'
import type { ChainStatus, KnightStatus } from '../hooks/useMissions'
import { getKnightConfig } from '../lib/knights'
import { phaseColor } from '../lib/status'
import { CostTag } from './CostTag'
import { tokensText } from '../lib/cost'

export function MissionResults({ name }: { name: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    setData(null)
    setError(null)
    setNotFound(false)
    setLoading(true)
    apiGet<Record<string, unknown>>(`/api/missions/${encodeURIComponent(name)}/results`, { signal: ctrl.signal })
      .then(d => { if (!ctrl.signal.aborted) setData(d) })
      .catch(e => {
        if (ctrl.signal.aborted) return
        if (e instanceof ApiError && e.status === 404) setNotFound(true)
        else setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [name])

  if (loading) return <p className="text-xs text-gray-500 py-2">Loading results...</p>
  if (notFound) return <p className="text-xs text-gray-500 py-2">No results stored yet</p>
  if (error) return <p className="text-xs text-red-400 py-2">Could not load results: {error}</p>

  return (
    <pre className="text-xs text-gray-300 whitespace-pre-wrap max-h-64 overflow-auto bg-roundtable-navy rounded p-3 border border-roundtable-gold/20">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

export function KnightStatusList({ statuses }: { statuses: KnightStatus[] }) {
  return (
    <div className="space-y-2">
      {statuses.map((knight) => {
        const config = getKnightConfig(knight.name)
        return (
          <div key={knight.name} className="bg-roundtable-navy/50 rounded-lg p-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">{config.emoji}</span>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-white font-medium capitalize">{knight.name}</span>
                  {knight.ephemeral && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 flex items-center gap-0.5">
                      <Zap className="w-2.5 h-2.5" />
                      ephemeral
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="flex items-center gap-1">
                    {knight.ready ? (
                      <CheckCircle className="w-3 h-3 text-green-400" />
                    ) : (
                      <XCircle className="w-3 h-3 text-red-400" />
                    )}
                    <span className={`text-xs ${knight.ready ? 'text-green-400' : 'text-red-400'}`}>
                      {knight.ready ? 'Ready' : 'Not Ready'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-400">
                    <Hash className="w-3 h-3" />
                    <span>{knight.tasksCompleted} tasks</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Chain statuses; with `chainHref` the chain name links to that URL. */
export function ChainStatusList({ statuses, chainHref }: { statuses: ChainStatus[]; chainHref?: (chain: ChainStatus) => string }) {
  return (
    <div className="space-y-2">
      {statuses.map((chain) => (
        <div key={chain.chainCRName} className="bg-roundtable-navy/50 rounded-lg p-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-gray-400" />
            <div>
              {chainHref
                ? <Link to={chainHref(chain)} className="text-sm text-roundtable-gold hover:underline font-medium">{chain.name}</Link>
                : <span className="text-sm text-white font-medium">{chain.name}</span>}
              <div className="text-xs text-gray-500 font-mono">{chain.chainCRName}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs" aria-label={`${chain.name} cost`}>
              <CostTag costUSD={chain.costUSD} notionalUSD={chain.notionalCostUSD} className="text-gray-300" />
              <div className="text-gray-500">{tokensText(chain.tokens)}</div>
            </div>
            <span className={`text-xs px-2 py-0.5 rounded border ${phaseColor(chain.phase)}`}>
              {chain.phase}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
