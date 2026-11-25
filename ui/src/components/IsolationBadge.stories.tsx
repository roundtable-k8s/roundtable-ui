import type { Meta, StoryObj } from '@storybook/react'
import { IsolationBadge } from './IsolationBadge'
import { isolated, notEnforced, optedOut } from '../test/fixtures/isolation'

const meta: Meta<typeof IsolationBadge> = {
  title: 'Components/IsolationBadge',
  component: IsolationBadge,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof IsolationBadge>

export const Isolated: Story = { args: { isolation: isolated } }
export const OptedOut: Story = { args: { isolation: optedOut } }
export const NotEnforced: Story = { args: { isolation: notEnforced } }
export const Unknown: Story = { args: { isolation: { state: 'unknown', hostnameRulesEnforced: false } } }
