import { useEffect, useState } from 'react'
import { useWebSocket } from './useWebSocket'
import { applyActivityMsg, emptyActivity, parseActivityMsg, type ActivityState } from '../lib/activity'

/**
 * Live activity of one task (#184): the API's backlog, then live events.
 * Pass null to watch nothing. Re-subscribes after reconnects (the backlog
 * then replaces the timeline, so nothing missed while offline is lost).
 */
export function useTaskActivity(taskId: string | null): ActivityState {
  const { watchActivity } = useWebSocket()
  const [state, setState] = useState<ActivityState>(emptyActivity)

  useEffect(() => {
    setState(emptyActivity)
    if (!taskId) return
    return watchActivity(taskId, (data) => {
      const msg = parseActivityMsg(data)
      if (msg) setState((prev) => applyActivityMsg(prev, msg))
    })
  }, [taskId, watchActivity])

  return state
}
