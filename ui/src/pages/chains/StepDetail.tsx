import { apiGet } from '../../lib/api'
import { useState, useEffect } from 'react'
import { getKnightConfig } from '../../lib/knights'
import { PhaseBadge, Badge } from '../../components/ui'
import { formatDuration } from '../../lib/format'
import type { ChainStep } from '../../lib/types'
import { sanitizeText } from '../../lib/untrusted'
import { CostTag } from '../../components/CostTag'
import { tokensText } from '../../lib/cost'
import { skipReasonText } from '../../lib/chains'

function StepKVOutput({ chainName, stepName }: { chainName: string; stepName: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setNotFound(false)
    setData(null)
    apiGet<Record<string, unknown>>(
      `/api/chains/${encodeURIComponent(chainName)}/steps/${encodeURIComponent(stepName)}/output`,
      { signal: controller.signal },
    )
      .then(d => { if (!controller.signal.aborted) setData(d) })
      .catch(e => {
        if (controller.signal.aborted) return
        if ((e as { status?: number })?.status === 404) setNotFound(true)
        else setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [chainName, stepName])

  if (loading) return <p className="text-xs text-gray-500 mt-2">Loading full output from KV...</p>
  if (notFound) return <p className="text-xs text-gray-500 mt-2">Full output not available</p>
  if (error) return <p role="alert" className="text-xs text-red-400 mt-2">Could not load full output: {error}</p>
  if (!data) return null

  const output = (data.output as string) || ''
  const duration = (data.duration as string) || ''

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-roundtable-gold uppercase font-semibold">📦 Full Output (NATS KV)</span>
        {duration && <span className="text-xs text-gray-500">⏱ {duration}</span>}
      </div>
      <pre className="text-xs text-gray-300 whitespace-pre-wrap max-h-96 overflow-auto bg-roundtable-navy rounded p-3 border border-roundtable-gold/20">
        {output}
      </pre>
    </div>
  )
}

export function StepDetail({ step, chainName }: { step: ChainStep; chainName: string }) {
  const cfg = getKnightConfig(step.knight)
  return (
    <div className="bg-roundtable-navy border border-roundtable-steel rounded-lg p-4 mt-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{cfg.emoji}</span>
        <span className="font-semibold text-white capitalize">{step.name}</span>
        <PhaseBadge phase={step.phase} />
        {step.continueOnFailure && (
          <Badge tone="yellow" strength="strong" className="font-medium">soft fail</Badge>
        )}
        <span className="text-xs text-gray-500 ml-auto">{formatDuration(step.startTime, step.completionTime)}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <div><span className="text-gray-500">Knight:</span> <span className="text-gray-300">{step.knight}</span></div>
        <div><span className="text-gray-500">Domain:</span> <span className="text-gray-300">{step.domain}</span></div>
        {step.dependsOn && step.dependsOn.length > 0 && (
          <div className="col-span-2"><span className="text-gray-500">Depends on:</span> <span className="text-gray-300">{step.dependsOn.join(', ')}</span></div>
        )}
        {(step.retryCount > 0 || step.maxRetries) && (
          <div>
            <span className="text-gray-500">Retries:</span> 
            <span className="text-yellow-400 ml-1">
              {step.retryCount > 0 ? `${step.retryCount}` : '0'}
              {step.maxRetries ? `/${step.maxRetries}` : ''}
            </span>
          </div>
        )}
        <div>
          <span className="text-gray-500">Cost:</span> <CostTag costUSD={step.costUSD} notional={step.costNotional} className="text-gray-300" />
        </div>
        <div><span className="text-gray-500">Tokens:</span> <span className="text-gray-300">{tokensText(step.tokens)}</span></div>
        {step.phase === 'Skipped' && (
          <div className="col-span-2"><span className="text-gray-500">Skipped:</span> <span className="text-gray-300">{skipReasonText(step)}</span></div>
        )}
        {step.outputPath && (
          <div className="col-span-2">
            <span className="text-gray-500">📁 Output path:</span> 
            <span className="text-gray-300 ml-1 font-mono text-xs">{step.outputPath}</span>
          </div>
        )}
      </div>
      {step.result && (
        <div>
          <span className="text-xs text-gray-500 uppercase">Result (truncated)</span>
          <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-64 overflow-auto mt-1 bg-roundtable-slate rounded p-3 border border-roundtable-steel/50">
            {sanitizeText(step.result)}
          </pre>
        </div>
      )}
      {(step.phase === 'Completed' || step.phase === 'Succeeded') && chainName && (
        <StepKVOutput chainName={chainName} stepName={step.name} />
      )}
    </div>
  )
}
