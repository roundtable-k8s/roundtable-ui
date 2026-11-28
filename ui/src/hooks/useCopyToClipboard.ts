import { useCallback, useEffect, useRef, useState } from 'react'

export const COPY_ERROR = 'Copy failed: the browser denied clipboard access'

/**
 * Copies text to the clipboard and flashes `copied` for `resetMs`. The timer
 * is cleared on unmount, and a rejected write (denied permission, non-HTTPS
 * origin) sets `error` instead of being swallowed.
 */
export function useCopyToClipboard(resetMs = 2000): { copy: (text: string) => Promise<boolean>; copied: boolean; error: string } {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])

  const copy = useCallback(async (text: string) => {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      if (mounted.current) {
        setCopied(false)
        setError(COPY_ERROR)
      }
      return false
    }
    if (mounted.current) {
      setError('')
      setCopied(true)
      timer.current = setTimeout(() => setCopied(false), resetMs)
    }
    return true
  }, [resetMs])

  return { copy, copied, error }
}
