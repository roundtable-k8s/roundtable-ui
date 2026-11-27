import type { Meta, StoryObj } from '@storybook/react'
import { MemoryRouter } from 'react-router-dom'
import { DeadLettersView } from './DeadLettersView'
import type { DeadLetter } from '../lib/deadLetters'

const base: DeadLetter = {
  taskId: 'galahad-ui-1', knight: 'galahad', state: 'open', reason: 'lost', attempt: 1,
  updatedAt: '2026-11-24T10:00:00Z', deadLetteredAt: '2026-11-24T10:00:00Z',
  error: 'delivered 5 times without an ack', task: { task: 'Scan the cluster for exposed secrets' },
}

const meta: Meta<typeof DeadLettersView> = {
  title: 'Components/DeadLettersView',
  component: DeadLettersView,
  tags: ['autodocs'],
  decorators: [(Story) => <MemoryRouter><Story /></MemoryRouter>],
  args: {
    entries: [],
    onRetry: async (e) => ({ taskId: `${e.taskId}-r2`, retryOf: e.taskId, attempt: 2, knight: e.knight }),
    onLoadDetail: async (e) => ({ ...base, ...e }),
    onLoadEntry: async (taskId) => ({ ...base, taskId, attempt: 1, error: 'timed out after 30m' }),
  },
}
export default meta
type Story = StoryObj<typeof DeadLettersView>

export const Empty: Story = {}
export const OpenLostEntry: Story = { args: { entries: [base] } }
export const FailedChainStep: Story = {
  args: { entries: [{ ...base, taskId: 'c-build-1', reason: 'failed', error: 'tests failed\nexit 1', chainName: 'pr-pipeline', stepName: 'build' }] },
}
export const ResolvedEntry: Story = { args: { entries: [{ ...base, state: 'resolved' }] } }
