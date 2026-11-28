import type { SessionEntry } from '../hooks/useKnightSession'

export interface EntryTone {
  /** Border + background classes for a full-width card. */
  card: string
  /** Background + text classes for a small type badge. */
  badge: string
}

const NEUTRAL_TONE: EntryTone = { card: 'border-gray-500/30 bg-gray-500/5', badge: 'bg-gray-500/20 text-gray-400' }

// Single colour map for session entry types (shared by the Sessions page and the knight drawer).
const entryTones: Record<string, EntryTone> = {
  user: { card: 'border-blue-500/30 bg-blue-500/5', badge: 'bg-blue-500/20 text-blue-400' },
  assistant: { card: 'border-green-500/30 bg-green-500/5', badge: 'bg-green-500/20 text-green-400' },
  tool_use: { card: 'border-purple-500/30 bg-purple-500/5', badge: 'bg-purple-500/20 text-purple-400' },
  tool_result: { card: 'border-amber-500/30 bg-amber-500/5', badge: 'bg-amber-500/20 text-amber-400' },
  thinking: NEUTRAL_TONE,
  compaction: { card: 'border-red-500/30 bg-red-500/5', badge: 'bg-red-500/20 text-red-400' },
}

export const entryTypeIcons: Record<string, string> = {
  user: '📨',
  assistant: '🤖',
  tool_use: '🔧',
  tool_result: '📋',
  thinking: '🧠',
  compaction: '📦',
}

// Message entries carry a `role` but a shared `type` of "message"; resolve a
// legible icon/tone/label from the role so they don't all render as "message".
function roleIcon(role?: string): string {
  return role === 'user' ? '📨' : role === 'assistant' ? '🤖' : '💬'
}

export function entryIcon(entry: SessionEntry): string {
  if (entry.type === 'message') return roleIcon(entry.role)
  return entryTypeIcons[entry.type] || '●'
}

export function entryTone(entry: SessionEntry): EntryTone {
  if (entry.type === 'message') {
    return entry.role === 'user' ? entryTones.user
      : entry.role === 'assistant' ? entryTones.assistant
      : NEUTRAL_TONE
  }
  return entryTones[entry.type] || NEUTRAL_TONE
}

// Never collapse to the bare wire type ("message"); prefer real text, then a
// role/tool descriptor. Returns whether the label is a placeholder so the UI
// can render it muted.
export function entryLabel(entry: SessionEntry): { text: string; placeholder: boolean } {
  const text = entry.text?.trim()
  if (text) return { text, placeholder: false }
  if (entry.type === 'message' && entry.role) {
    return { text: `${entry.role} message`, placeholder: true }
  }
  if (entry.toolName) return { text: entry.toolName, placeholder: false }
  return { text: entry.type, placeholder: true }
}

export function entryTokens(entry: SessionEntry): number {
  return entry.tokens ? entry.tokens.input + entry.tokens.output : 0
}
