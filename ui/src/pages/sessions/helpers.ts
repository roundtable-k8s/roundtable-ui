import type { SessionHistoryItem } from '../../hooks/useKnightSession'
import { formatDateTime } from '../../lib/format'

// Human label for a past session in the picker: when it ran, message count, and the opening prompt.
export function sessionLabel(s: SessionHistoryItem): string {
  const when = s.startedAt ? formatDateTime(s.startedAt) : 'unknown time'
  const prompt = s.firstPrompt ? ` — ${s.firstPrompt.slice(0, 60)}` : ''
  return `${when} · ${s.messageCount} msgs${prompt}`
}

// Picker value for a past session: "<pod>/<id>" so the transcript is always
// fetched from the pod it lives on (#219). Neither pod names nor session ids
// contain "/".
export function sessionHistoryKey(s: SessionHistoryItem): string {
  return s.pod ? `${s.pod}/${s.id}` : s.id
}

// Query string selecting a past session from its picker value.
export function sessionQuery(key: string): string {
  const slash = key.indexOf('/')
  if (slash < 0) return `id=${encodeURIComponent(key)}`
  return `id=${encodeURIComponent(key.slice(slash + 1))}&pod=${encodeURIComponent(key.slice(0, slash))}`
}

// Pod named in a picker value ("<pod>/<id>"), or null for a bare id.
export function sessionPod(key: string): string | null {
  const slash = key.indexOf('/')
  return slash < 0 ? null : key.slice(0, slash)
}
