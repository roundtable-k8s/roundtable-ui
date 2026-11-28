import type { Meta, StoryObj } from '@storybook/react'
import { PhaseBadge } from './index'

const meta: Meta<typeof PhaseBadge> = { title: 'Primitives/PhaseBadge', component: PhaseBadge, tags: ['autodocs'], args: { phase: 'Running' } }
export default meta
type Story = StoryObj<typeof PhaseBadge>

export const Single: Story = {}

const PHASES = [
  'Idle', 'Pending', 'Unknown', 'Skipped', 'Expired',
  'Provisioning', 'Running', 'StepRunning', 'Active', 'Planning', 'Assembling', 'Briefing',
  'Ready', 'Succeeded', 'Completed', 'Degraded', 'PartiallySucceeded',
  'Paused', 'Suspended', 'CleaningUp', 'OverBudget', 'Failed', 'Error',
]

/** Every phase in the shared colour map, plus an unmapped one that falls back to Pending. */
export const AllPhases: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 max-w-xl">
      {[...PHASES, 'SomethingNew'].map(p => <PhaseBadge key={p} phase={p} />)}
    </div>
  ),
}
