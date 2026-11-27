/**
 * Shared UI primitives. Every page previously hand-rolled these idioms
 * (spinners, error banners, empty states, headers, stat cards, badges,
 * collapsibles, overlays, progress bars) with drifting styles — this is
 * the one copy.
 */
import { useEffect, useId, useRef, useState, type ReactNode, type ComponentType, type RefObject } from 'react'
import { RefreshCw, ChevronDown, ChevronUp, X } from 'lucide-react'
import { phaseColor } from '../../lib/status'
import { formatTimestamp } from '../../lib/format'

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

/** Gold ring spinner. */
export function Spinner({ size = 'md', decorative = false }: { size?: 'sm' | 'md'; decorative?: boolean }) {
  const dims = size === 'sm' ? 'w-5 h-5' : 'w-8 h-8'
  return (
    <div {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-label': 'Loading' })}
      className={`animate-spin ${dims} border-2 border-roundtable-gold border-t-transparent rounded-full`} />
  )
}

/** Red error banner. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm">
      {children}
    </div>
  )
}

/** Centered icon + message for "nothing here yet" sections. */
export function EmptyState({ icon: Icon, title, sub, titleAs: Title = 'p' }: {
  icon?: ComponentType<{ className?: string }>
  title: string
  sub?: string
  /** Element for the title; use 'h1' when the empty state is the whole page. */
  titleAs?: 'p' | 'h1' | 'h2'
}) {
  return (
    <div className="text-center py-12">
      {Icon && <Icon className="w-12 h-12 text-gray-600 mx-auto mb-3" />}
      <Title className="text-gray-500">{title}</Title>
      {sub && <p className="text-gray-600 text-sm mt-1">{sub}</p>}
    </div>
  )
}

/**
 * The one loading / empty / error treatment for list pages, so a page can
 * never say "empty" while loading or after a failed fetch.
 *  - error, no data: banner "Failed to load {what}: {error}" (+ Retry)
 *  - error, data:    the banner above the children
 *  - loading, no data: spinner with "Loading {what}…" (role="status")
 *  - nothing to show: EmptyState (plus `emptyExtra`)
 *  - otherwise: children
 */
export function ListState({ loading, error, count, what, emptyTitle, emptySub, emptyExtra, icon, onRetry, children }: {
  loading: boolean
  error?: string | null
  count: number
  what: string
  emptyTitle: string
  emptySub?: string
  emptyExtra?: ReactNode
  icon?: ComponentType<{ className?: string }>
  onRetry?: () => void
  children?: ReactNode
}) {
  const banner = error ? (
    <div className="mb-6">
      <ErrorBanner>
        Failed to load {what}: {error}
        {onRetry && count === 0 && (
          <button onClick={onRetry} className="ml-3 underline hover:text-red-300">Retry</button>
        )}
      </ErrorBanner>
    </div>
  ) : null
  if (error && count === 0) return banner
  if (error) return <>{banner}{children}</>
  if (count === 0 && loading) {
    return (
      <div role="status" className="text-center py-12">
        <div className="flex justify-center mb-3"><Spinner decorative /></div>
        <p className="text-gray-500 text-sm">Loading {what}…</p>
      </div>
    )
  }
  if (count === 0) {
    return (
      <div data-testid="list-empty">
        <EmptyState icon={icon} title={emptyTitle} sub={emptySub} />
        {emptyExtra}
      </div>
    )
  }
  return <>{children}</>
}

/* ------------------------------------------------------------------ */
/* Page chrome                                                         */
/* ------------------------------------------------------------------ */

/** Page title row: gold icon + h1 (+ optional subtitle) left, actions right. */
export function PageHeader({ icon: Icon, title, subtitle, children }: {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          <Icon className="w-8 h-8 text-roundtable-gold" />
          {title}
        </h1>
        {subtitle && <p className="text-gray-400 mt-2">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  )
}

export function RefreshButton({ onClick, loading = false, disabled = false, updatedAt }: {
  onClick: () => void
  loading?: boolean
  disabled?: boolean
  /** Epoch ms of the last successful fetch; shown as "Updated hh:mm:ss" before the button. */
  updatedAt?: number | null
}) {
  const stamp = updatedAt != null ? new Date(updatedAt) : null
  return (
    <>
      {stamp && (
        <span className="text-xs text-gray-500" aria-live="off" title={stamp.toLocaleString()}>
          Updated {formatTimestamp(stamp)}
        </span>
      )}
      <button
        onClick={onClick}
        disabled={disabled}
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-roundtable-steel/50 hover:bg-roundtable-steel text-gray-300 rounded-lg transition-colors disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Data display                                                        */
/* ------------------------------------------------------------------ */

/** "Label + big colored value" tile used on every overview page. */
export function StatCard({ label, value, total, color = 'text-white', icon, detail }: {
  label: string
  value: string | number
  total?: number
  color?: string
  icon?: ReactNode
  detail?: string
}) {
  return (
    <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="text-gray-400 text-xs">{label}</p>
        {icon && <span className={color}>{icon}</span>}
      </div>
      <p className={`text-2xl font-bold mt-1 ${color}`}>
        {value}
        {total !== undefined && <span className="text-gray-500 text-lg">/{total}</span>}
      </p>
      {detail && <p className="text-xs text-gray-500 mt-0.5">{detail}</p>}
    </div>
  )
}

/** Phase pill colored via the shared lib/status map. */
export function PhaseBadge({ phase }: { phase: string }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${phaseColor(phase)}`}>
      {phase}
    </span>
  )
}

/** Horizontal meter: track + colored fill, percent 0–100. */
export function ProgressBar({ percent, fillClass = 'bg-roundtable-gold/40', heightClass = 'h-2' }: {
  percent: number
  fillClass?: string
  heightClass?: string
}) {
  return (
    <div className={`${heightClass} bg-roundtable-navy rounded-full overflow-hidden`}>
      <div
        className={`${heightClass} ${fillClass} rounded-full transition-all`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Disclosure & overlays                                               */
/* ------------------------------------------------------------------ */

/** Chevron-toggled section. Uncontrolled; pass defaultOpen to start open. */
export function Collapsible({ title, defaultOpen = false, children }: {
  title: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between w-full text-left text-sm text-gray-300 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-2">{title}</span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}

/** Open dialogs, innermost last. Only the top one handles keyboard events. */
const dialogStack: object[] = []

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Dialog keyboard behaviour: focus moves in on open and returns to the opener
 *  on close, Tab stays inside, Escape calls onClose unless disabled. */
function useDialogBehavior(ref: RefObject<HTMLElement | null>, onClose: () => void, closeOnEscape: boolean) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const escRef = useRef(closeOnEscape)
  escRef.current = closeOnEscape

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const el = ref.current
    if (el && !el.contains(document.activeElement)) {
      const first = el.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? el).focus()
    }
    const token = {}
    dialogStack.push(token)
    const onKeyDown = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return
      if (e.key === 'Escape') {
        if (escRef.current) {
          e.stopPropagation()
          onCloseRef.current()
        }
        return
      }
      if (e.key !== 'Tab' || !ref.current) return
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        ref.current.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === ref.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (!ref.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const i = dialogStack.indexOf(token)
      if (i >= 0) dialogStack.splice(i, 1)
      if (opener && opener.isConnected) opener.focus()
    }
  }, [ref])
}

/** Centered modal with dimmed backdrop. Closes via the X button or Escape
 *  (unless closeOnEscape is false) — backdrop clicks are ignored so stray
 *  clicks can't discard form state. */
export function Modal({ onClose, title, icon, children, closeOnEscape = true }: {
  onClose: () => void
  title: ReactNode
  icon?: ReactNode
  children: ReactNode
  closeOnEscape?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialogBehavior(ref, onClose, closeOnEscape)
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-roundtable-slate border border-roundtable-steel rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        <div className="flex items-center justify-between p-6 border-b border-roundtable-steel">
          <h2 id={titleId} className="text-xl font-bold text-white flex items-center gap-2">
            {icon}
            {title}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Right-side slide-over panel with dimmed backdrop. Closes on backdrop click or Escape. */
export function Drawer({ onClose, children, label, widthClass = 'w-full max-w-xl' }: {
  onClose: () => void
  children: ReactNode
  /** Accessible name of the dialog. */
  label: string
  widthClass?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogBehavior(ref, onClose, true)
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`fixed right-0 top-0 h-full ${widthClass} bg-roundtable-slate border-l border-roundtable-steel z-50 overflow-y-auto focus:outline-none`}
      >
        {children}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* RoundTable selector and badge                                       */
/* ------------------------------------------------------------------ */

/** Select one RoundTable or all of them. Hidden when there is only one table. */
export function TableSelect({ tables, value, onChange }: {
  tables: string[]
  value: string
  onChange: (table: string) => void
}) {
  // Keep a table named in the URL selectable even if it is not listed (yet).
  const names = value && !tables.includes(value) ? [...tables, value] : tables
  if (names.length < 2) return null
  return (
    <div className="flex items-center gap-2">
      <label htmlFor="table-select" className="text-xs text-gray-400">Table</label>
      <select
        id="table-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-2 py-1 text-sm text-white"
      >
        <option value="">All tables</option>
        {names.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </div>
  )
}

/** Small badge naming the table an object belongs to; renders nothing without one. */
export function TableBadge({ table }: { table?: string }) {
  if (!table) return null
  return (
    <span data-testid="table-badge" className="text-xs bg-roundtable-gold/10 text-roundtable-gold px-2 py-0.5 rounded font-mono">
      {table}
    </span>
  )
}
