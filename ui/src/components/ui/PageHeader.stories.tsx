import type { Meta, StoryObj } from '@storybook/react'
import { Users } from 'lucide-react'
import { PageHeader, RefreshButton } from './index'

const meta: Meta<typeof PageHeader> = { title: 'Primitives/PageHeader', component: PageHeader, tags: ['autodocs'], args: { icon: Users, title: 'Knights' } }
export default meta
type Story = StoryObj<typeof PageHeader>

export const TitleOnly: Story = {}
export const WithSubtitle: Story = { args: { subtitle: '12 knights across 2 tables' } }
export const WithActions: Story = {
  args: { subtitle: '12 knights across 2 tables', children: <RefreshButton onClick={() => {}} updatedAt={1700000000000} /> },
}
