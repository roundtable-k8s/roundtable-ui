import type { Meta, StoryObj } from '@storybook/react'
import { TableBadge } from './index'

const meta: Meta<typeof TableBadge> = { title: 'Primitives/TableBadge', component: TableBadge, tags: ['autodocs'] }
export default meta
type Story = StoryObj<typeof TableBadge>

export const Named: Story = { args: { table: 'roundtable-dev' } }
/** Renders nothing without a table. */
export const NoTable: Story = {}
