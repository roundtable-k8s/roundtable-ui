import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SkillFilter } from './SkillFilter'

describe('SkillFilter', () => {
  it('renders without tags or clear button when inactive', () => {
    render(<SkillFilter tags={[]} value={{}} onChange={vi.fn()} shown={3} total={3} />)
    expect(screen.getByLabelText('Filter by skill')).toHaveValue('')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/knights/)).toBeNull()
  })

  it('emits the typed text and keeps the tag', () => {
    const onChange = vi.fn()
    render(<SkillFilter tags={['vault']} value={{ tag: 'vault' }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Filter by skill'), { target: { value: 'scan' } })
    expect(onChange).toHaveBeenCalledWith({ tag: 'vault', text: 'scan' })
  })

  it('selects a tag, and deselects it on a second click', () => {
    const onChange = vi.fn()
    const { rerender } = render(<SkillFilter tags={['vault', 'k8s']} value={{}} onChange={onChange} />)
    const btn = screen.getByRole('button', { name: 'vault' })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(btn)
    expect(onChange).toHaveBeenLastCalledWith({ tag: 'vault' })

    rerender(<SkillFilter tags={['vault', 'k8s']} value={{ tag: 'vault', text: 'x' }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: 'vault' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'vault' }))
    expect(onChange).toHaveBeenLastCalledWith({ tag: undefined, text: 'x' })
  })

  it('shows the count and a clear button when active', () => {
    const onChange = vi.fn()
    render(<SkillFilter tags={[]} value={{ text: 'scan' }} onChange={onChange} shown={2} total={5} />)
    expect(screen.getByText('2 of 5 knights')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(onChange).toHaveBeenCalledWith({})
  })

  it('omits the count without shown/total', () => {
    render(<SkillFilter tags={[]} value={{ text: 'scan' }} onChange={vi.fn()} />)
    expect(screen.queryByText(/knights$/)).toBeNull()
    expect(screen.getByRole('button', { name: /Clear/ })).toBeInTheDocument()
  })
})
