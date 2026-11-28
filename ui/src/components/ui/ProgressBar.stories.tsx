import type { Meta, StoryObj } from '@storybook/react'
import { ProgressBar } from './index'

const meta: Meta<typeof ProgressBar> = {
  title: 'Primitives/ProgressBar',
  component: ProgressBar,
  tags: ['autodocs'],
  args: { percent: 50 },
  decorators: [(Story) => <div className="w-64"><Story /></div>],
}
export default meta
type Story = StoryObj<typeof ProgressBar>

export const Half: Story = {}
export const Empty: Story = { args: { percent: 0 } }
export const Full: Story = { args: { percent: 100 } }
/** Out-of-range values are clamped to 0–100. */
export const Clamped: Story = { args: { percent: 150 } }
export const CustomColourAndHeight: Story = { args: { percent: 70, fillClass: 'bg-green-500/60', heightClass: 'h-4' } }
