import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Modal } from './index'

export type ButtonTone = 'gold' | 'gray' | 'red' | 'green' | 'amber'
export type ButtonSize = 'sm' | 'md'

const BASE = 'inline-flex items-center rounded-lg border font-medium transition-colors disabled:opacity-50'
const SIZES: Record<ButtonSize, string> = {
  sm: 'gap-1 px-2 py-1 text-xs',
  md: 'gap-1.5 px-3 py-1.5 text-sm',
}
const TONES: Record<ButtonTone, string> = {
  gold: 'border-roundtable-gold/30 bg-roundtable-gold/10 text-roundtable-gold hover:bg-roundtable-gold/20',
  gray: 'border-roundtable-steel bg-roundtable-navy text-gray-300 hover:text-white',
  red: 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20',
  green: 'border-green-500/30 bg-green-500/10 text-green-300 hover:bg-green-500/20',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20',
}

export function buttonClass(tone: ButtonTone = 'gray', size: ButtonSize = 'md', extra = ''): string {
  return [BASE, SIZES[size], TONES[tone], extra].filter(Boolean).join(' ')
}

type LookProps = { tone?: ButtonTone; size?: ButtonSize; icon?: ReactNode }

/** The shared button. Renders type="button" unless a type is given. */
export function Button({ tone, size, icon, className, children, type = 'button', ...rest }: LookProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={buttonClass(tone, size, className)} {...rest}>
      {icon}{children}
    </button>
  )
}

/** The same look for a react-router Link. */
export function LinkButton({ tone, size, icon, className, children, ...rest }: LookProps & LinkProps) {
  return (
    <Link className={buttonClass(tone, size, `no-underline${className ? ' ' + className : ''}`)} {...rest}>
      {icon}{children}
    </Link>
  )
}

/** A Modal with a message body and a Cancel / confirm row; both disabled while working. */
export function ConfirmDialog({ title, icon, confirmLabel, workingLabel = 'Working…', tone = 'gold', working, error, onCancel, onConfirm, testId, children }: {
  title: ReactNode
  icon?: ReactNode
  confirmLabel: ReactNode
  workingLabel?: ReactNode
  tone?: ButtonTone
  working: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
  testId?: string
  children: ReactNode
}) {
  return (
    <Modal onClose={onCancel} title={title} icon={icon}>
      <div className="p-6 space-y-4 text-sm" data-testid={testId}>
        {children}
        {error && <p role="alert" className="text-sm text-red-400 break-words">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel} disabled={working}>Cancel</Button>
          <Button tone={tone} onClick={onConfirm} disabled={working}>{working ? workingLabel : confirmLabel}</Button>
        </div>
      </div>
    </Modal>
  )
}
