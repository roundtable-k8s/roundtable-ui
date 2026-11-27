import { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'

export interface VersionInfo {
  version?: string
  commit?: string
  buildTime?: string
  goVersion?: string
}

/** GET /api/version once (no polling); null while loading or on failure. */
export function useVersion(): VersionInfo | null {
  const [data, setData] = useState<VersionInfo | null>(null)
  useEffect(() => {
    let live = true
    apiGet<VersionInfo>('/api/version').then((v) => { if (live && v) setData(v) }).catch(() => {})
    return () => { live = false }
  }, [])
  return data
}
