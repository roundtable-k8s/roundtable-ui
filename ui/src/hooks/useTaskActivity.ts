import { useEffect, useState } from 'react'
import { useWebSocket } from './useWebSocket'
import { applyActivityMessage, initialActivityState, type ActivityState } from '../lib/activity'

/**
 * Watch one task's live activity over the shared /api/ws connection (#214).
 *
 * Sends `{"subscribe":"activity","taskId"}` whenever the socket is (re)connected
 * — the server forgets watches on reconnect and answers with a fresh backlog —
 * and `{"unsubscribe":"activity","taskId"}` when the task changes or the
 * component unmounts.
 */
export function useTaskActivity(taskId: string | null | undefined): ActivityState {
  const { connected, subscribeTopic, send } = useWebSocket()
  const [state, setState] = useState<ActivityState>(initialActivityState)

  // Reset when switching tasks.
  useEffect(() => {
    setState(initialActivityState)
  }, [taskId])

  useEffect(() => {
    if (!taskId) return
    const off = subscribeTopic('activity', (msg) => {
      setState((prev) => applyActivityMessage(prev, msg, taskId))
    })
    return off
  }, [taskId, subscribeTopic])

  useEffect(() => {
    if (!taskId || !connected) return
    send({ subscribe: 'activity', taskId })
    return () => {
      send({ unsubscribe: 'activity', taskId })
    }
  }, [taskId, connected, send])

  return state
}
