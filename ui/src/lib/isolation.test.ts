import { describe, it, expect } from 'vitest'
import { isNotIsolated, isolationTooltip, optOutSummary } from './isolation'
import { isolated, notEnforced, optedOut } from '../test/fixtures/isolation'

describe('isolation helpers', () => {
  it('isNotIsolated matches opted out and not enforced only', () => {
    expect(isNotIsolated({ isolation: optedOut })).toBe(true)
    expect(isNotIsolated({ isolation: notEnforced })).toBe(true)
    expect(isNotIsolated({ isolation: isolated })).toBe(false)
    expect(isNotIsolated({ isolation: { state: 'unknown', hostnameRulesEnforced: false } })).toBe(false)
    expect(isNotIsolated({})).toBe(false)
  })

  it('tooltip names the opt-out and its reason', () => {
    expect(optOutSummary(optedOut)).toBe('egress: unrestricted')
    expect(isolationTooltip(optedOut)).toBe('Opted out (egress: unrestricted): scrapes arbitrary sites')
    expect(isolationTooltip({ ...optedOut, runtimeOptOut: true })).toBe(
      'Opted out (runtime: none, egress: unrestricted): scrapes arbitrary sites',
    )
  })

  it('tooltip gives the condition reason and message otherwise', () => {
    expect(isolationTooltip(notEnforced)).toBe('FQDNPolicyUnavailable: cilium.io/v2 CiliumNetworkPolicy is not served')
    expect(isolationTooltip(isolated)).toContain('Isolated: RuntimeClass "gvisor" applies')
  })
})
