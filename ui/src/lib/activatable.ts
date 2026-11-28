import type { KeyboardEvent, MouseEvent } from 'react'

export const FOCUS_RING = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-roundtable-gold/60'

/**
 * Props that make a clickable non-button element operable from the keyboard:
 * a tab stop with role="button" that activates on Enter and Space. Events that
 * bubble up from inner controls (checkboxes, buttons) are ignored.
 */
export function activatable(onActivate: () => void, expanded?: boolean) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    ...(expanded === undefined ? {} : { 'aria-expanded': expanded }),
    onClick: (e: MouseEvent) => { if (e.target === e.currentTarget || !isInner(e)) onActivate() },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
  }
}

function isInner(e: MouseEvent): boolean {
  const el = (e.target as HTMLElement).closest?.('button, a, input, select, textarea, [role="button"]')
  return !!el && el !== e.currentTarget
}
