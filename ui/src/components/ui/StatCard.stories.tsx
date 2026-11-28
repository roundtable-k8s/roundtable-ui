import type { Meta, StoryObj } from '@storybook/react'
import { Activity } from 'lucide-react'
import { StatCard } from './index'

const meta: Meta<typeof StatCard> = { title: 'Primitives/StatCard', component: StatCard, tags: ['autodocs'], args: { label: 'Online', value: 8 } }
export default meta
type Story = StoryObj<typeof StatCard>

export const Basic: Story = {}
export const WithTotal: Story = { args: { total: 12 } }
export const WithColorAndIcon: Story = { args: { color: 'text-green-400', icon: <Activity className="w-4 h-4" /> } }
export const WithDetail: Story = { args: { detail: '2 starting' } }
export const Everything: Story = { args: { total: 12, color: 'text-green-400', icon: <Activity className="w-4 h-4" />, detail: '2 starting' } }
