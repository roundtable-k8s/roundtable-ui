import { useState } from 'react'
import { sanitizeText } from '../lib/untrusted'

interface UntrustedTextProps {
  text: unknown
  /** Element to render; always plain text children, never HTML. */
  as?: 'pre' | 'p' | 'span' | 'div'
  className?: string
  /** Content longer than this is collapsed (not removed) behind a toggle. */
  collapseAfter?: number
}

/**
 * Renders model/tool/log content as inert plain text: React escapes it, ANSI
 * and control characters are stripped, long content is collapsed (#188).
 */
export function UntrustedText({ text, as: Tag = 'pre', className, collapseAfter = 4000 }: UntrustedTextProps) {
  const [open, setOpen] = useState(false)
  const clean = sanitizeText(text)
  const long = clean.length > collapseAfter
  const shown = long && !open ? clean.slice(0, collapseAfter) : clean
  return (
    <>
      <Tag className={className}>{shown}{long && !open ? '…' : ''}</Tag>
      {long && (
        <button type="button" className="text-xs text-roundtable-gold hover:underline" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all (${clean.length.toLocaleString()} chars)`}
        </button>
      )}
    </>
  )
}
