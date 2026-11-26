import { ExternalLink } from 'lucide-react'
import { useConfig } from '../hooks/useConfig'
import { traceUrl } from '../lib/trace'

/** "View trace" link; renders nothing without a configured template or a trace ID. */
export function TraceLink({ traceId }: { traceId?: string }) {
  const { traceUrlTemplate } = useConfig()
  const href = traceUrl(traceUrlTemplate, traceId)
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 text-sm">
      View trace <ExternalLink className="w-3 h-3" />
    </a>
  )
}
