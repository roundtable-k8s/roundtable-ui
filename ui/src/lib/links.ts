/** Deep link to a chain on the Chains page. */
export function chainHref(chainName: string): string {
  return `/chains?chain=${encodeURIComponent(chainName)}`
}

/** Deep link to a task's live activity on the Running page. */
export function runningHref(taskId: string): string {
  return `/running?task=${encodeURIComponent(taskId)}`
}
