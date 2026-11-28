import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DataTable } from '.'

const columns = [
  { key: 'name', header: 'Name' },
  { key: 'count', header: 'Count', align: 'right' as const },
]

describe('DataTable', () => {
  it('uses the label as the accessible name', () => {
    render(<DataTable label="Things" columns={columns}><tr><td>a</td><td>1</td></tr></DataTable>)
    expect(screen.getByRole('table', { name: 'Things' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'a' })).toBeInTheDocument()
  })

  it('gives every header scope="col"', () => {
    render(<DataTable label="Things" columns={columns}><tr><td>a</td><td>1</td></tr></DataTable>)
    const headers = screen.getAllByRole('columnheader')
    expect(headers).toHaveLength(2)
    headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'))
  })

  it('right-aligns only right columns', () => {
    render(<DataTable label="Things" columns={columns}><tr><td>a</td><td>1</td></tr></DataTable>)
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveClass('text-right')
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveClass('text-right')
  })

  it('applies density and describedBy', () => {
    render(
      <>
        <span id="hint">Hint</span>
        <DataTable label="Things" columns={columns} density="compact" describedBy="hint"><tr><td>a</td><td>1</td></tr></DataTable>
      </>,
    )
    expect(screen.getByRole('table', { name: 'Things' })).toHaveAccessibleDescription('Hint')
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveClass('px-3', 'py-2')
  })

  it('defaults to comfortable density', () => {
    render(<DataTable label="Things" columns={columns}><tr><td>a</td><td>1</td></tr></DataTable>)
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveClass('px-4', 'py-3')
  })
})
