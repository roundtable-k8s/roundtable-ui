import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FirstRun, FIRST_RUN_COMMAND } from './FirstRun'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FirstRun', () => {
  it('explains what a Knight is and links the getting started guide', () => {
    render(<FirstRun />)
    expect(screen.getByRole('heading', { name: 'No knights yet' })).toBeInTheDocument()
    expect(screen.getByText(/A Knight is one long-running agent/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Getting started guide' })).toHaveAttribute(
      'href',
      'https://github.com/roundtable-k8s/roundtable/blob/main/docs/getting-started.md',
    )
  })

  it('points the command at the operator quickstart manifests on main', () => {
    expect(FIRST_RUN_COMMAND).toBe(
      'kubectl apply -f https://raw.githubusercontent.com/roundtable-k8s/roundtable/main/examples/quickstart/roundtable.yaml -f https://raw.githubusercontent.com/roundtable-k8s/roundtable/main/examples/quickstart/knight.yaml',
    )
    expect(screen.queryByText(FIRST_RUN_COMMAND)).toBeNull()
    render(<FirstRun />)
    expect(screen.getByText(FIRST_RUN_COMMAND)).toBeInTheDocument()
  })

  it('copies the command and shows confirmation', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<FirstRun />)
    fireEvent.click(screen.getByRole('button', { name: /Copy command/ }))
    expect(writeText).toHaveBeenCalledWith(FIRST_RUN_COMMAND)
    await waitFor(() => expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument())
  })

  it('stays usable when clipboard access is denied', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<FirstRun />)
    fireEvent.click(screen.getByRole('button', { name: /Copy command/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /Copy command/ })).toBeInTheDocument()
  })
})
