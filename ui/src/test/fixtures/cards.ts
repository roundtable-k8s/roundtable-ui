import type { CardEntry } from '../../lib/cards'

/** A live knight with skills, load from a NATS micro STATS response. */
export const galahadCard: CardEntry = {
  table: 'personal',
  knight: 'galahad',
  live: true,
  stats: {
    name: 'roundtable-knight',
    endpoints: [{ name: 'card', data: { activeTasks: 1, maxConcurrentTasks: 3, tasksTotal: 42, tasksFailed: 1 } }],
  },
  card: {
    name: 'galahad',
    description: 'Security analyst: CVE triage and the daily security brief.',
    version: '7',
    skills: [
      { id: 'cve-triage', name: 'cve-triage', description: 'Triage a CVE against the fleet images.', tags: ['security'] },
      { id: 'threat-model', name: 'threat-model', description: 'Threat-model a design doc.', tags: ['security', 'design'] },
    ],
    roundtable: {
      table: 'personal',
      knight: 'galahad',
      domain: 'security',
      model: 'claude-sonnet-4-20250514',
      tools: ['nmap', 'whois'],
      taskSubject: 'fleet-a.tasks.security.galahad',
      runtime: 'deployment',
      phase: 'Ready',
      readyReplicas: 1,
      suspended: false,
    },
  },
}

/** A suspended knight: card kept, nothing answering. */
export const patsyCard: CardEntry = {
  table: 'personal',
  knight: 'patsy',
  live: false,
  stats: null,
  card: {
    name: 'patsy',
    description: 'Vault keeper: files notes and briefings.',
    skills: [{ id: 'vault', name: 'vault', description: 'vault skills', tags: ['vault'] }],
    roundtable: {
      table: 'personal',
      knight: 'patsy',
      domain: 'vault',
      model: 'claude-haiku-4',
      tools: ['rg'],
      taskSubject: 'fleet-a.tasks.vault.patsy',
      suspended: true,
    },
  },
}
