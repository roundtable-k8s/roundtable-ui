import type { Meta, StoryObj } from '@storybook/react'
import { Users } from 'lucide-react'
import { ListState } from './index'

const meta: Meta<typeof ListState> = {
  title: 'Primitives/ListState',
  component: ListState,
  tags: ['autodocs'],
  args: { what: 'knights', emptyTitle: 'No knights yet', emptySub: 'Create a Knight resource to see it here.', icon: Users, loading: false, count: 0 },
}
export default meta
type Story = StoryObj<typeof ListState>

const list = <ul className="text-gray-300 text-sm"><li>galahad</li><li>lancelot</li></ul>

export const Loading: Story = { args: { loading: true } }
export const Empty: Story = {}
export const EmptyWithExtra: Story = { args: { emptyExtra: <p className="text-center text-gray-500 text-sm">Extra hint below the empty state</p> } }
export const ErrorNoData: Story = { args: { error: 'connection refused', onRetry: () => {} } }
export const ErrorWithData: Story = { args: { error: 'connection refused', count: 2, children: list } }
export const Loaded: Story = { args: { count: 2, children: list } }
