import type { Meta, StoryObj } from '@storybook/react'
import { CopyButton } from './index'

const meta: Meta<typeof CopyButton> = { title: 'Primitives/CopyButton', component: CopyButton, tags: ['autodocs'], args: { text: 'kubectl get knights' } }
export default meta
type Story = StoryObj<typeof CopyButton>

export const Default: Story = {}
export const CustomLabels: Story = { args: { label: 'Copy command', copiedLabel: 'Copied!' } }
export const IconOnly: Story = { args: { iconOnly: true, ariaLabel: 'Copy snapshot name', iconClassName: 'w-3 h-3', className: 'text-gray-500 hover:text-roundtable-gold' } }
export const Disabled: Story = { args: { disabled: true } }
