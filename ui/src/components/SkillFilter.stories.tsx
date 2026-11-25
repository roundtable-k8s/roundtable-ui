import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react'
import { SkillFilter } from './SkillFilter'
import type { SkillFilter as SkillFilterValue } from '../lib/cards'

const meta: Meta<typeof SkillFilter> = {
  title: 'Components/SkillFilter',
  component: SkillFilter,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof SkillFilter>

function Interactive({ initial }: { initial: SkillFilterValue }) {
  const [value, setValue] = useState<SkillFilterValue>(initial)
  return <SkillFilter tags={['design', 'security', 'vault']} value={value} onChange={setValue} shown={1} total={3} />
}

export const Empty: Story = { render: () => <Interactive initial={{}} /> }
export const TagSelected: Story = { render: () => <Interactive initial={{ tag: 'security' }} /> }
export const TextQuery: Story = { render: () => <Interactive initial={{ text: 'cve' }} /> }
