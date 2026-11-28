import type { Meta, StoryObj } from '@storybook/react'
import { Users } from 'lucide-react'
import { EmptyState } from './index'

const meta: Meta<typeof EmptyState> = { title: 'Primitives/EmptyState', component: EmptyState, tags: ['autodocs'] }
export default meta
type Story = StoryObj<typeof EmptyState>

export const TitleOnly: Story = { args: { title: 'No knights yet' } }
export const WithIconAndSub: Story = { args: { icon: Users, title: 'No knights yet', sub: 'Create a Knight resource to see it here.' } }
/** Use h1 when the empty state is the whole page. */
export const AsPageHeading: Story = { args: { icon: Users, title: 'Nothing here', titleAs: 'h1' } }
