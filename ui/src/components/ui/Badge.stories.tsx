import type { Meta, StoryObj } from '@storybook/react'
import { GitBranch } from 'lucide-react'
import { Badge } from './index'
import { TONES } from '../../lib/tone'

const meta: Meta<typeof Badge> = { title: 'Primitives/Badge', component: Badge, tags: ['autodocs'], args: { tone: 'green', children: 'Active' } }
export default meta
type Story = StoryObj<typeof Badge>

export const Single: Story = {}

export const AllTones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 max-w-xl">
      {TONES.map(t => <Badge key={t} tone={t}>{t}</Badge>)}
    </div>
  ),
}

export const Strengths: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge tone="blue" strength="soft">soft</Badge>
      <Badge tone="blue" strength="strong">strong</Badge>
      <Badge tone="gray" strength="muted">muted</Badge>
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Badge tone="sky" size="xs">xs</Badge>
      <Badge tone="sky" size="sm">sm</Badge>
    </div>
  ),
}

export const WithIcon: Story = {
  render: () => <Badge tone="sky" icon={<GitBranch className="w-3 h-3" aria-hidden />} title="Change it in Git">managed in Git</Badge>,
}
