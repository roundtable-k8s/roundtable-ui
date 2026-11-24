import type { Meta, StoryObj } from '@storybook/react'
import { QueueSparkline } from './QueueSparkline'
import type { QueueSample } from '../lib/queues'

const T0 = Date.parse('2026-11-24T12:00:00Z')
const series = (pending: number[], replicas: number[]): QueueSample[] =>
  pending.map((p, i) => ({ t: T0 + i * 15_000, pending: p, ackPending: 0, replicas: replicas[i] }))

const meta: Meta<typeof QueueSparkline> = {
  title: 'Components/QueueSparkline',
  component: QueueSparkline,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof QueueSparkline>

export const BacklogWithScaleUp: Story = {
  args: { samples: series([8, 8, 7, 4, 2, 0, 0, 0], [1, 1, 3, 3, 3, 3, 2, 1]) },
}
export const Idle: Story = { args: { samples: series([0, 0, 0, 0], [1, 1, 1, 1]) } }
export const Collecting: Story = { args: { samples: series([3], [1]) } }
