/**
 * Form primitives: one input class string and one label / hint / error /
 * aria wiring for every form (ScheduleForm, MissionWizard, ...).
 */
import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { sanitizeText } from '../../lib/untrusted'

export type FieldSize = 'xs' | 'sm'

export interface InputClassOptions {
  invalid?: boolean
  /** `indigo` is the meta-mission planner's accent. */
  tone?: 'default' | 'indigo'
  /** `sm` renders text-sm; `md` inherits the surrounding size. */
  size?: 'sm' | 'md'
}

/** Class string shared by every text input, textarea and select. */
export function inputClass({ invalid = false, tone = 'default', size = 'md' }: InputClassOptions = {}): string {
  const border = invalid ? 'border-red-500/60' : tone === 'indigo' ? 'border-indigo-500/30' : 'border-roundtable-steel'
  const focus = tone === 'indigo' ? 'focus:border-indigo-500/50' : 'focus:border-roundtable-gold/50'
  return `w-full px-3 py-2 bg-roundtable-navy border ${border} rounded-lg text-white placeholder-gray-500 focus:outline-none ${focus}${size === 'sm' ? ' text-sm' : ''}`
}

/** Id of the error paragraph a field renders (and its control points at). */
export function fieldErrorId(id: string): string {
  return `${id}-error`
}

interface FieldProps {
  /** The id of the control the label points at. */
  id: string
  label: string
  error?: string
  /** Hidden while an error shows. */
  hint?: ReactNode
  /** Label size: `xs` gray-400 (ScheduleForm) or `sm` gray-300 (MissionWizard). */
  size?: FieldSize
  /** Override of the error element id (default `<id>-error`). */
  errorId?: string
  children: ReactNode
}

/** Label, control, hint and error message. */
export function Field({ id, label, error, hint, size = 'xs', errorId, children }: FieldProps) {
  const labelClass = size === 'xs' ? 'text-xs font-medium text-gray-400' : 'text-sm text-gray-300'
  return (
    <div>
      <label htmlFor={id} className={`block ${labelClass} mb-1`}>{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
      {error && (
        <p id={errorId ?? fieldErrorId(id)} role="alert" data-testid={`error-${id}`} className="mt-1 text-xs text-red-300">
          {sanitizeText(error)}
        </p>
      )}
    </div>
  )
}

interface ControlExtras extends Omit<InputClassOptions, 'invalid'> {
  /** The validation message: marks the control invalid and describes it by the error element. */
  error?: string
  /** Override of the error element id (default `<id>-error`). */
  errorId?: string
}

function controlProps(id: string | undefined, { error, errorId }: ControlExtras) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': errorId ?? (id ? fieldErrorId(id) : undefined) } : {}
}

export type TextInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & ControlExtras

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { error, errorId, tone, size, className = '', ...rest }, ref,
) {
  return <input ref={ref} {...controlProps(rest.id, { error, errorId })} {...rest}
    className={`${inputClass({ invalid: !!error, tone, size })} ${className}`.trim()} />
})

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & ControlExtras

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { error, errorId, tone, size, className = '', ...rest }, ref,
) {
  return <textarea ref={ref} {...controlProps(rest.id, { error, errorId })} {...rest}
    className={`${inputClass({ invalid: !!error, tone, size })} ${className}`.trim()} />
})

export type SelectInputProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & ControlExtras

export const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput(
  { error, errorId, tone, size, className = '', ...rest }, ref,
) {
  return <select ref={ref} {...controlProps(rest.id, { error, errorId })} {...rest}
    className={`${inputClass({ invalid: !!error, tone, size })} ${className}`.trim()} />
})
