import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { PageHeader } from './index'

describe('PageHeader mobile layout', () => {
  it('wraps the header row and the actions so they fit a phone', () => {
    render(<PageHeader icon={Bell} title="Things"><button>Act</button></PageHeader>)
    const row = screen.getByRole('heading', { name: 'Things' }).parentElement!.parentElement!
    expect(row.className).toContain('flex-wrap')
    expect(screen.getByRole('heading', { name: 'Things' }).parentElement!.className).toContain('min-w-0')
    expect(screen.getByRole('button', { name: 'Act' }).parentElement!.className).toContain('flex-wrap')
  })
})
