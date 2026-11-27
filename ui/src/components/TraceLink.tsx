import { ExternalLink } from 'lucide-react'
import { useConfig } from '../hooks/useConfig'
import { traceUrl } from '../lib/trace'

/** "View trace" link; renders nothing without a configured template or a trace ID. `size` sets the text size (default `sm`). */
export function TraceLink({ traceId, size = 'sm' }: { traceId?: string; size?: 'sm' | 'xs' }) {
  const { traceUrlTemplate } = useConfig()
  const href = traceUrl(traceUrlTemplate, traceId)
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 ${size === 'xs' ? 'text-xs' : 'text-sm'}`}>
      View trace <ExternalLink className="w-3 h-3" />
    </a>
  )
}
