import { useCallback, useEffect, useState } from 'react'
import { Skull } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { PageHeader, RefreshButton } from '../components/ui'
import { DeadLettersView } from '../components/DeadLettersView'
import { DEAD_LETTERS_URL, deadLetterUrl, type DeadLetter, type RetryResult } from '../lib/deadLetters'

export function FailedTasksPage() {
  const [entries, setEntries] = useState<DeadLetter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ deadLetters?: DeadLetter[] }>(DEAD_LETTERS_URL)
      setEntries(data.deadLetters ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dead letters')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const onRetry = (d: DeadLetter, force: boolean) =>
    apiPost<RetryResult>(`${DEAD_LETTERS_URL}/${encodeURIComponent(d.taskId)}/retry`, { force, ...(d.table ? { table: d.table } : {}) })
      .then((res) => { load(); return res })

  return (
    <div>
      <PageHeader icon={Skull} title="Failed & lost">
        <RefreshButton onClick={load} loading={loading} />
      </PageHeader>
      <DeadLettersView
        entries={entries}
        loading={loading}
        error={error}
        onRetry={onRetry}
        onLoadDetail={(d) => apiGet<DeadLetter>(deadLetterUrl(d))}
      />
    </div>
  )
}
