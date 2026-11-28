import type { Meta, StoryObj } from '@storybook/react'
import { useState } from 'react'
import { TableSelect } from './index'

const meta: Meta<typeof TableSelect> = {
  tags: ['autodocs'],
  title: 'Primitives/TableSelect',
  component: TableSelect,
}
export default meta
type Story = StoryObj<typeof TableSelect>

function Controlled({ tables, initial = '' }: { tables: string[]; initial?: string }) {
  const [value, setValue] = useState(initial)
  return <TableSelect tables={tables} value={value} onChange={setValue} />
}

export const AllTables: Story = { render: () => <Controlled tables={['personal', 'roundtable-dev']} /> }
export const OneSelected: Story = { render: () => <Controlled tables={['personal', 'roundtable-dev']} initial="personal" /> }
/** A single table renders nothing. */
export const SingleTable: Story = { render: () => <Controlled tables={['personal']} /> }
