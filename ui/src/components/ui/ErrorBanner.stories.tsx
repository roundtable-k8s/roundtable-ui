import type { Meta, StoryObj } from '@storybook/react'
import { ErrorBanner } from './index'

const meta: Meta<typeof ErrorBanner> = { title: 'Primitives/ErrorBanner', component: ErrorBanner, tags: ['autodocs'] }
export default meta
type Story = StoryObj<typeof ErrorBanner>

export const Default: Story = { args: { children: 'Failed to load knights: 503 Service Unavailable' } }
