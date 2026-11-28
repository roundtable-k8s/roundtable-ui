import type { Meta, StoryObj } from '@storybook/react'
import { SnapshotButton } from './SnapshotButton'
import type { Knight } from '../hooks/useFleet'

const knight: Knight = {
  name: 'galahad', domain: 'dev', status: 'online', ready: true, restarts: 0, age: '1h',
  image: 'img', labels: {},
}

const meta: Meta<typeof SnapshotButton> = {
  title: 'Components/SnapshotButton',
  component: SnapshotButton,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof SnapshotButton>

/** A knight with no snapshots yet. */
export const NoSnapshots: Story = {
  args: { name: 'galahad', namespace: 'roundtable', knight, onDetail: () => {} },
}
