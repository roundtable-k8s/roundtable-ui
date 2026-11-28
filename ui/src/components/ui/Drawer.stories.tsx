import type { Meta, StoryObj } from '@storybook/react'
import { Drawer } from './index'

const meta: Meta<typeof Drawer> = {
  title: 'Primitives/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: { label: 'Knight details', onClose: () => {}, children: <div className="p-6 text-gray-300 text-sm">Drawer body</div> },
}
export default meta
type Story = StoryObj<typeof Drawer>

export const Open: Story = {}
export const Narrow: Story = { args: { widthClass: 'w-80' } }
