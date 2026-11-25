import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TableSelect, TableBadge } from './index'

describe('TableSelect', () => {
  it('is hidden with a single table', () => {
    const { container } = render(<TableSelect tables={['personal']} value="" onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists all tables and reports the choice', async () => {
    const onChange = vi.fn()
    render(<TableSelect tables={['personal', 'roundtable-dev']} value="" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Table'), 'personal')
    expect(onChange).toHaveBeenCalledWith('personal')
    await userEvent.selectOptions(screen.getByLabelText('Table'), '')
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('keeps a table from the URL selectable even when unknown', () => {
    render(<TableSelect tables={['personal']} value="gone" onChange={() => {}} />)
    expect(screen.getByLabelText('Table')).toHaveValue('gone')
  })
})

describe('TableBadge', () => {
  it('renders nothing without a table', () => {
    const { container } = render(<TableBadge />)
    expect(container).toBeEmptyDOMElement()
  })
})
