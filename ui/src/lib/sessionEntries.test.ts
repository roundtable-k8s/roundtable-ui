import { describe, it, expect } from 'vitest'
import type { SessionEntry } from '../hooks/useKnightSession'
import { entryIcon, entryTone, entryLabel, entryTokens } from './sessionEntries'

const e = (p: Partial<SessionEntry>) => ({ id: '1', type: 'message', timestamp: '', ...p }) as SessionEntry

describe('sessionEntries', () => {
  it('maps icons incl. thinking, compaction and message roles', () => {
    expect(entryIcon(e({ type: 'thinking' }))).toBe('🧠')
    expect(entryIcon(e({ type: 'compaction' }))).toBe('📦')
    expect(entryIcon(e({ role: 'user' }))).toBe('📨')
    expect(entryIcon(e({ role: 'assistant' }))).toBe('🤖')
    expect(entryIcon(e({ role: 'system' }))).toBe('💬')
    expect(entryIcon(e({ type: 'weird' }))).toBe('●')
  })
  it('resolves tones from type or role', () => {
    expect(entryTone(e({ role: 'user' })).card).toContain('blue')
    expect(entryTone(e({ type: 'tool_use' })).badge).toContain('purple')
    expect(entryTone(e({ type: 'nope' })).card).toContain('gray')
  })
  it('labels without collapsing to "message"', () => {
    expect(entryLabel(e({ role: 'assistant', text: '' }))).toEqual({ text: 'assistant message', placeholder: true })
    expect(entryLabel(e({ type: 'tool_use', toolName: 'bash' }))).toEqual({ text: 'bash', placeholder: false })
  })
  it('sums tokens', () => {
    expect(entryTokens(e({ tokens: { input: 2, output: 3 } as SessionEntry['tokens'] }))).toBe(5)
    expect(entryTokens(e({}))).toBe(0)
  })
})
