import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal, Drawer } from './index'

function Harness({ closeOnEscape, drawer }: { closeOnEscape?: boolean; drawer?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      {open && (drawer
        ? <Drawer label="Details" onClose={() => setOpen(false)}><button>inner</button></Drawer>
        : <Modal title="Confirm" closeOnEscape={closeOnEscape} onClose={() => setOpen(false)}><button>ok</button></Modal>)}
    </>
  )
}

describe('Modal', () => {
  it('has dialog role named by its title and a named close button', () => {
    render(<Modal title="Delete x?" onClose={() => {}}><p>body</p></Modal>)
    const d = screen.getByRole('dialog', { name: 'Delete x?' })
    expect(d).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('moves focus in, closes on Escape and restores focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('opener'))
    expect(screen.getByRole('dialog', { name: 'Confirm' }).contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('opener')).toHaveFocus()
  })

  it('ignores Escape with closeOnEscape={false}', async () => {
    const user = userEvent.setup()
    render(<Harness closeOnEscape={false} />)
    await user.click(screen.getByText('opener'))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('opener'))
    const d = screen.getByRole('dialog')
    for (let i = 0; i < 5; i++) {
      await user.tab()
      expect(d.contains(document.activeElement)).toBe(true)
    }
    await user.tab({ shift: true })
    expect(d.contains(document.activeElement)).toBe(true)
  })

  it('does not close on backdrop click', async () => {
    const onClose = vi.fn()
    const { container } = render(<Modal title="t" onClose={onClose}>x</Modal>)
    await userEvent.click(container.firstChild as Element)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Drawer', () => {
  it('has dialog role with label, closes on Escape and restores focus', async () => {
    const user = userEvent.setup()
    render(<Harness drawer />)
    await user.click(screen.getByText('opener'))
    expect(screen.getByRole('dialog', { name: 'Details' })).toHaveAttribute('aria-modal', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('opener')).toHaveFocus()
  })
})
