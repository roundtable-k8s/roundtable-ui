import type { Meta, StoryObj } from '@storybook/react'
import { KnightDetailDrawer } from './KnightDetailDrawer'
import type { Knight } from '../hooks/useFleet'

const meta: Meta<typeof KnightDetailDrawer> = {
  title: 'Components/KnightDetailDrawer',
  component: KnightDetailDrawer,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
}
export default meta

type Story = StoryObj<typeof KnightDetailDrawer>

const mockKnight: Knight = {
  name: 'galahad',
  domain: 'security',
  status: 'online',
  ready: true,
  restarts: 0,
  age: '3d 12h',
  image: 'ghcr.io/roundtable/knight:latest',
  skills: 4,
  nixTools: 7,
  labels: {},
}

export const Open: Story = {
  args: {
    knight: mockKnight,
    onClose: () => {},
  },
}

export const OfflineKnight: Story = {
  args: {
    knight: { ...mockKnight, name: 'tristan', domain: 'infra', status: 'offline', ready: false, restarts: 5, age: '45m' },
    onClose: () => {},
  },
}

export const Closed: Story = {
  args: {
    knight: null,
    onClose: () => {},
  },
}

export const WithFullCRDData: Story = {
  args: {
    knight: {
      ...mockKnight,
      name: 'galahad',
      domain: 'security',
      status: 'online',
      ready: true,
      phase: 'Ready',
      model: 'claude-sonnet-4-20250514',
      runtime: 'deployment',
      suspend: false,
      tasksCompleted: 156,
      tasksFailed: 3,
      totalCost: '$24.56',
      concurrency: 5,
      taskTimeoutSeconds: 600,
      restarts: 2,
      age: '7d 14h',
      skillsList: ['nmap', 'nuclei', 'trivy', 'semgrep', 'osv-scanner'],
      generatedSkills: [
        {
          name: 'vulnerability-scan',
          content: 'Comprehensive vulnerability scanning across all network endpoints using nmap and nuclei.',
        },
        {
          name: 'container-audit',
          content: 'Audit container images for security vulnerabilities using Trivy and OSV Scanner.',
        },
      ],
      labels: {
        'roundtable.io/table': 'roundtable-alpha',
        'app.kubernetes.io/name': 'knight',
        'app.kubernetes.io/instance': 'galahad',
      },
    },
    onClose: () => {},
  },
}

export const SandboxKnight: Story = {
  args: {
    knight: {
      ...mockKnight,
      name: 'coder-2',
      domain: 'coding',
      status: 'online',
      ready: true,
      phase: 'Ready',
      model: 'claude-sonnet-4-20250514',
      runtime: 'sandbox',
      suspend: false,
      tasksCompleted: 42,
      tasksFailed: 1,
      totalCost: '$5.23',
      concurrency: 3,
      taskTimeoutSeconds: 300,
      age: '2d 8h',
      skillsList: ['git', 'docker', 'npm', 'python'],
      labels: {
        'roundtable.io/table': 'roundtable-alpha',
        'roundtable.io/runtime': 'sandbox',
      },
    },
    onClose: () => {},
  },
}
