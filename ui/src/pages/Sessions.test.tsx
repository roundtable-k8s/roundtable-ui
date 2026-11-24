import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { ToolCallCard, TreeNodeView, sessionHistoryKey, sessionQuery } from './Sessions'
import type { SessionEntry, SessionTreeNode, SessionHistoryItem } from '../hooks/useKnightSession'

function entry(over: Partial<SessionEntry>): SessionEntry {
  return { id: 'e1', parentId: null, type: 'message', timestamp: '2026-07-08T06:05:35Z', ...over }
}

describe('ToolCallCard timeline legibility', () => {
  it('shows a role-based label instead of a bare "message" when text is empty', () => {
    render(<ToolCallCard entry={entry({ type: 'message', role: 'assistant', text: '' })} />)
    // Regression: previously collapsed to the wire type "message"
    expect(screen.getByText('assistant message')).toBeInTheDocument()
    expect(screen.queryByText('message')).not.toBeInTheDocument()
  })

  it('prefers real text content when present', () => {
    render(<ToolCallCard entry={entry({ role: 'user', text: 'Generate the digest' })} />)
    expect(screen.getByText('Generate the digest')).toBeInTheDocument()
  })

  it('keeps the timestamp on a single line (no wrap)', () => {
    render(<ToolCallCard entry={entry({ role: 'assistant', text: 'hi' })} />)
    const ts = screen.getByText((_, el) => el?.textContent?.includes(':05:') ?? false, { selector: 'span' })
    expect(ts.className).toContain('whitespace-nowrap')
  })
})

describe('TreeNodeView indentation', () => {
  function node(over: Partial<SessionTreeNode>): SessionTreeNode {
    return { id: 'n1', parentId: null, type: 'message', timestamp: '2026-07-08T06:00:00Z', childrenCount: 0, summary: 'user: hello', ...over }
  }

  it('caps indent so deep chains do not march off-screen', () => {
    const { container } = render(<TreeNodeView node={node({})} depth={40} />)
    const padded = container.querySelector('[style*="padding-left"]') as HTMLElement
    // 12 (cap) * 16px, not 40 * 16 = 640px
    expect(padded.style.paddingLeft).toBe('192px')
  })

  it('shallow nodes still indent proportionally', () => {
    const { container } = render(<TreeNodeView node={node({})} depth={3} />)
    const padded = container.querySelector('[style*="padding-left"]') as HTMLElement
    expect(padded.style.paddingLeft).toBe('48px')
  })
})

describe('per-pod session selection (#219)', () => {
  const item = (over: Partial<SessionHistoryItem>): SessionHistoryItem =>
    ({ id: '019f4162-77c7', startedAt: null, entryCount: 1, messageCount: 1, firstPrompt: '', sizeBytes: null, ...over })

  it('keys a past session by its pod so the same pod is asked for the transcript', () => {
    const key = sessionHistoryKey(item({ pod: 'galahad-7d9f-abc' }))
    expect(key).toBe('galahad-7d9f-abc/019f4162-77c7')
    expect(sessionQuery(key)).toBe('id=019f4162-77c7&pod=galahad-7d9f-abc')
  })

  it('keeps the bare id when the API did not report a pod (older runtime)', () => {
    const key = sessionHistoryKey(item({}))
    expect(key).toBe('019f4162-77c7')
    expect(sessionQuery(key)).toBe('id=019f4162-77c7')
  })

  it('gives the same id on two pods distinct keys', () => {
    expect(sessionHistoryKey(item({ pod: 'a' }))).not.toBe(sessionHistoryKey(item({ pod: 'b' })))
  })
})
