import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Field, SelectInput, TextArea, TextInput, inputClass } from './Form'

describe('inputClass', () => {
  it('uses the red border when invalid and the indigo one for the indigo tone', () => {
    expect(inputClass()).toContain('border-roundtable-steel')
    expect(inputClass({ invalid: true })).toContain('border-red-500/60')
    expect(inputClass({ tone: 'indigo' })).toContain('border-indigo-500/30')
    expect(inputClass({ size: 'sm' })).toContain('text-sm')
  })
})

describe('Field', () => {
  it('shows the hint without an error', () => {
    render(<Field id="a" label="A" hint="a hint"><TextInput id="a" /></Field>)
    expect(screen.getByText('a hint')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('hides the hint while an error shows, as an alert with the error id', () => {
    render(<Field id="a" label="A" hint="a hint" error="bad"><TextInput id="a" error="bad" /></Field>)
    expect(screen.queryByText('a hint')).toBeNull()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('bad')
    expect(alert).toHaveAttribute('id', 'a-error')
    expect(alert).toHaveAttribute('data-testid', 'error-a')
  })

  it('honours an errorId override', () => {
    render(<Field id="a" label="A" error="bad" errorId="wiz-err-a"><TextInput id="a" error="bad" errorId="wiz-err-a" /></Field>)
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'wiz-err-a')
    expect(screen.getByLabelText('A')).toHaveAttribute('aria-describedby', 'wiz-err-a')
  })
})

describe('controls', () => {
  it('set aria-invalid and aria-describedby only when there is an error', () => {
    render(<>
      <TextInput id="t" aria-label="t" error="x" />
      <TextArea id="ta" aria-label="ta" error="x" />
      <SelectInput id="s" aria-label="s" error="x"><option>one</option></SelectInput>
      <TextInput id="ok" aria-label="ok" />
    </>)
    for (const [label, id] of [['t', 't'], ['ta', 'ta'], ['s', 's']]) {
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-describedby', `${id}-error`)
    }
    expect(screen.getByLabelText('ok')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByLabelText('ok')).not.toHaveAttribute('aria-describedby')
  })

  it('forward refs and merge className', () => {
    const ref = createRef<HTMLInputElement>()
    render(<TextInput ref={ref} aria-label="r" className="font-mono" />)
    expect(ref.current).toBe(screen.getByLabelText('r'))
    expect(ref.current?.className).toContain('font-mono')
  })
})
