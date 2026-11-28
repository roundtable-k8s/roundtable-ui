import type { Meta, StoryObj } from '@storybook/react'
import { Field, SelectInput, TextArea, TextInput } from './Form'

const meta: Meta<typeof Field> = {
  tags: ['autodocs'],
  title: 'Primitives/Form',
  component: Field,
}
export default meta
type Story = StoryObj<typeof Field>

export const WithHint: Story = {
  render: () => <Field id="n" label="Name" hint="Lower-case letters and dashes."><TextInput id="n" placeholder="morning-digest" /></Field>,
}
export const WithError: Story = {
  render: () => <Field id="n" label="Name" error="Name is required"><TextInput id="n" error="Name is required" /></Field>,
}
export const LargeLabel: Story = {
  render: () => <Field id="n" label="Objective" size="sm"><TextArea id="n" rows={3} /></Field>,
}
export const Select: Story = {
  render: () => <Field id="s" label="Table"><SelectInput id="s"><option>personal</option><option>roundtable-dev</option></SelectInput></Field>,
}
export const IndigoTone: Story = {
  render: () => <Field id="p" label="Planner timeout"><TextInput id="p" tone="indigo" size="sm" /></Field>,
}
