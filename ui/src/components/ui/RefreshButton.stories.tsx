import type { Meta, StoryObj } from '@storybook/react'
import { RefreshButton } from './index'

const meta: Meta<typeof RefreshButton> = { title: 'Primitives/RefreshButton', component: RefreshButton, tags: ['autodocs'], args: { onClick: () => {} } }
export default meta
type Story = StoryObj<typeof RefreshButton>

export const Idle: Story = {}
export const Loading: Story = { args: { loading: true } }
export const Disabled: Story = { args: { disabled: true } }
export const WithUpdatedAt: Story = { args: { updatedAt: 1700000000000 } }
