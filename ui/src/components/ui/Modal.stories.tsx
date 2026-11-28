import type { Meta, StoryObj } from '@storybook/react'
import { Rocket } from 'lucide-react'
import { Modal } from './index'

const meta: Meta<typeof Modal> = {
  title: 'Primitives/Modal',
  component: Modal,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: { title: 'Create mission', onClose: () => {}, children: <div className="p-6 text-gray-300 text-sm">Modal body</div> },
}
export default meta
type Story = StoryObj<typeof Modal>

export const Open: Story = {}
export const WithIcon: Story = { args: { icon: <Rocket className="w-5 h-5 text-roundtable-gold" /> } }
/** Escape does nothing, e.g. while a form has unsaved state. */
export const EscapeDisabled: Story = { args: { closeOnEscape: false } }
