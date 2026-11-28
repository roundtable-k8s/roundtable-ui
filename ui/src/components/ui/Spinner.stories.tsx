import type { Meta, StoryObj } from '@storybook/react'
import { Spinner } from './index'

const meta: Meta<typeof Spinner> = { title: 'Primitives/Spinner', component: Spinner, tags: ['autodocs'] }
export default meta
type Story = StoryObj<typeof Spinner>

export const Medium: Story = {}
export const Small: Story = { args: { size: 'sm' } }
/** Hidden from assistive tech when a sibling already announces the loading state. */
export const Decorative: Story = { args: { decorative: true } }
