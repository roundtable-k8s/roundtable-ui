import type { Meta, StoryObj } from '@storybook/react'
import { expect, fireEvent, within } from '@storybook/test'
import { CopyButton } from './index'
import { COPY_ERROR } from '../../hooks/useCopyToClipboard'

function stubClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

const meta: Meta<typeof CopyButton> = { title: 'Primitives/CopyButton', component: CopyButton, tags: ['autodocs'], args: { text: 'kubectl get knights' } }
export default meta
type Story = StoryObj<typeof CopyButton>

export const Default: Story = {}
export const CustomLabels: Story = { args: { label: 'Copy command', copiedLabel: 'Copied!' } }
export const IconOnly: Story = { args: { iconOnly: true, ariaLabel: 'Copy snapshot name', iconClassName: 'w-3 h-3', className: 'text-gray-500 hover:text-roundtable-gold' } }
export const Disabled: Story = { args: { disabled: true } }

export const Copied: Story = {
  play: async ({ canvasElement }) => {
    stubClipboard(() => Promise.resolve())
    const canvas = within(canvasElement)
    fireEvent.click(canvas.getByRole('button'))
    await expect(await canvas.findByText('Copied')).toBeInTheDocument()
  },
}
export const ClipboardDenied: Story = {
  play: async ({ canvasElement }) => {
    stubClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    const canvas = within(canvasElement)
    fireEvent.click(canvas.getByRole('button'))
    await expect(await canvas.findByText(COPY_ERROR)).toBeInTheDocument()
  },
}
