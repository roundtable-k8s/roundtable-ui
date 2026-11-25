import type { KnightIsolation } from '../../hooks/useFleet'

export const isolated: KnightIsolation = {
  state: 'isolated',
  reason: 'Isolated',
  message: 'RuntimeClass "gvisor" applies; hostname rules applied',
  runtimeClassName: 'gvisor',
  hostnameRulesEnforced: true,
  egress: {
    allowedHosts: ['api.anthropic.com', '*.github.com'],
    allowedPorts: [443],
    allowedServices: [{ name: 'nats', namespace: 'nats', ports: [4222] }],
    source: 'knight',
  },
  isolated: { type: 'Isolated', status: 'True', reason: 'Isolated' },
  egressRestricted: { type: 'EgressRestricted', status: 'True', reason: 'FQDNPolicyApplied' },
}

export const optedOut: KnightIsolation = {
  state: 'opted-out',
  reason: 'OptedOut',
  message: 'Knight opts out of isolation (egress: unrestricted): scrapes arbitrary sites',
  egressOptOut: true,
  optOutReason: 'scrapes arbitrary sites',
  runtimeClassName: 'gvisor',
  hostnameRulesEnforced: false,
  isolated: { type: 'Isolated', status: 'False', reason: 'OptedOut' },
}

export const notEnforced: KnightIsolation = {
  state: 'not-enforced',
  reason: 'FQDNPolicyUnavailable',
  message: 'cilium.io/v2 CiliumNetworkPolicy is not served',
  runtimeClassName: 'gvisor',
  hostnameRulesEnforced: false,
  egress: { allowedHosts: ['pypi.org'], allowedPorts: [443], allowedServices: [], source: 'table' },
  isolated: { type: 'Isolated', status: 'False', reason: 'FQDNPolicyUnavailable' },
  egressRestricted: { type: 'EgressRestricted', status: 'False', reason: 'FQDNPolicyUnavailable' },
}
