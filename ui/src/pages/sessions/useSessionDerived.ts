import { useMemo } from 'react'
import type { SessionEntry, SessionTreeNode } from '../../hooks/useKnightSession'

export function useSessionDerived(entries: SessionEntry[], treeNodes: SessionTreeNode[], view: 'timeline' | 'tree' | 'tools', filterType: string, searchQuery: string) {
  // Build tree from flat nodes
  const tree = useMemo(() => {
    if (treeNodes.length === 0) return []
    const map = new Map<string, SessionTreeNode & { children: SessionTreeNode[] }>()
    for (const n of treeNodes) map.set(n.id, { ...n, children: [] })
    const roots: (SessionTreeNode & { children: SessionTreeNode[] })[] = []
    for (const n of treeNodes) {
      const node = map.get(n.id)!
      if (n.parentId && map.has(n.parentId)) {
        map.get(n.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    return roots
  }, [treeNodes])

  // Filter entries
  const filteredEntries = useMemo(() => {
    let result = entries
    if (view === 'tools') {
      result = result.filter(e => e.type === 'tool_use' || e.type === 'tool_result')
    }
    if (filterType) {
      result = result.filter(e => e.type === filterType)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(e =>
        (e.text?.toLowerCase().includes(q)) ||
        (e.toolName?.toLowerCase().includes(q)) ||
        (e.input?.toLowerCase().includes(q)) ||
        (e.output?.toLowerCase().includes(q))
      )
    }
    return result
  }, [entries, view, filterType, searchQuery])

  // Tool call stats
  const toolStats = useMemo(() => {
    const tools = entries.filter(e => e.type === 'tool_use')
    const byName: Record<string, number> = {}
    for (const t of tools) {
      const name = t.toolName || 'unknown'
      byName[name] = (byName[name] || 0) + 1
    }
    return { total: tools.length, byName: Object.entries(byName).sort((a, b) => b[1] - a[1]) }
  }, [entries])

  return { tree, filteredEntries, toolStats }
}
