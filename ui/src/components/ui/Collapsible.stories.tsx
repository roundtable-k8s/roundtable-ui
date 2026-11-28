import type { Meta, StoryObj } from '@storybook/react'
import { Collapsible } from './index'

const meta: Meta<typeof Collapsible> = {
  title: 'Primitives/Collapsible',
  component: Collapsible,
  tags: ['autodocs'],
  args: { title: 'Details', children: <p className="text-gray-400 text-sm">Hidden until opened.</p> },
}
export default meta
type Story = StoryObj<typeof Collapsible>

export const Closed: Story = {}
export const Open: Story = { args: { defaultOpen: true } }
