import type { Meta, StoryObj } from '@storybook/react'
import { DataTable } from './index'

const meta: Meta<typeof DataTable> = {
  title: 'Primitives/DataTable',
  component: DataTable,
  tags: ['autodocs'],
  args: {
    label: 'Queues',
    columns: [
      { key: 'knight', header: 'Knight' },
      { key: 'pending', header: 'Pending', align: 'right' },
    ],
  },
  render: (args) => (
    <DataTable {...args}>
      <tr className="border-b border-roundtable-steel/50 last:border-0">
        <td className="px-4 py-3 text-white">galahad</td>
        <td className="px-4 py-3 text-right tabular-nums text-gray-200">3</td>
      </tr>
    </DataTable>
  ),
}
export default meta
type Story = StoryObj<typeof DataTable>

export const Comfortable: Story = {}
export const Compact: Story = { args: { density: 'compact' } }
