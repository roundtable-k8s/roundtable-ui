// Knight metadata and display config
export interface KnightDisplayConfig {
  emoji: string
  color: string
  title: string
  domain: string
}

/** Display defaults (emoji/colour) only — not the list of knights; the fleet API is. */
export const KNIGHT_CONFIG: Record<string, KnightDisplayConfig> = {
  galahad: { emoji: '🛡️', color: 'text-red-400', title: 'Security', domain: 'security' },
  kay: { emoji: '📡', color: 'text-blue-400', title: 'Research', domain: 'research' },
  tristan: { emoji: '🏗️', color: 'text-cyan-400', title: 'Infrastructure', domain: 'infra' },
  gawain: { emoji: '☀️', color: 'text-yellow-400', title: 'Orchestrator', domain: 'project' },
  agravain: { emoji: '🗡️', color: 'text-orange-400', title: 'Pentest', domain: 'pentest' },
  bedivere: { emoji: '🏠', color: 'text-green-400', title: 'Home', domain: 'home' },
  percival: { emoji: '📋', color: 'text-purple-400', title: 'Finance', domain: 'finance' },
  patsy: { emoji: '🥥', color: 'text-amber-400', title: 'Vault', domain: 'vault' },
  gareth: { emoji: '🌿', color: 'text-emerald-400', title: 'Wellness', domain: 'wellness' },
  lancelot: { emoji: '⚔️', color: 'text-indigo-400', title: 'Career', domain: 'career' },
  'coder-1': { emoji: '💻', color: 'text-sky-400', title: 'Coder', domain: 'coding' },
  'coder-2': { emoji: '💻', color: 'text-sky-400', title: 'Coder', domain: 'coding' },
}

const DOMAIN_EMOJI: Record<string, string> = {
  security: '🛡️', research: '📡', infra: '🏗️', project: '☀️',
  pentest: '🗡️', home: '🏠', finance: '📋', vault: '🥥',
  wellness: '🌿', career: '⚔️', coding: '💻', lead: '👑',
  backend: '⚙️', frontend: '🎨', data: '📊', qa: '🧪',
  devops: '🔧', planning: '🗺️', turtle: '🐢',
}

const DOMAIN_COLOR: Record<string, string> = {
  security: 'text-red-400', research: 'text-blue-400', infra: 'text-cyan-400',
  project: 'text-yellow-400', pentest: 'text-orange-400', home: 'text-green-400',
  finance: 'text-purple-400', vault: 'text-amber-400', wellness: 'text-emerald-400',
  career: 'text-indigo-400', coding: 'text-sky-400', lead: 'text-yellow-300',
  backend: 'text-teal-400', frontend: 'text-pink-400', data: 'text-violet-400',
  qa: 'text-lime-400', devops: 'text-orange-300', planning: 'text-rose-400',
  turtle: 'text-emerald-300',
}

// Build dynamic config from fleet API response, using KNIGHT_CONFIG as fallback
export function buildKnightConfigFromFleet(knights: Array<{ name: string; domain: string }>): Record<string, KnightDisplayConfig> {
  const config = { ...KNIGHT_CONFIG }
  for (const knight of knights) {
    if (!config[knight.name]) {
      config[knight.name] = {
        emoji: DOMAIN_EMOJI[knight.domain] || '🤖',
        color: DOMAIN_COLOR[knight.domain] || 'text-gray-400',
        title: knight.domain.charAt(0).toUpperCase() + knight.domain.slice(1),
        domain: knight.domain,
      }
    }
  }
  return config
}

export function getKnightConfig(name: string): KnightDisplayConfig {
  return KNIGHT_CONFIG[name] || { emoji: '🤖', color: 'text-gray-400', title: name, domain: name }
}

/** Domain -> knight name for the fleet; a domain is kept only when exactly one knight has it. */
export function domainIndex(knights: ReadonlyArray<{ name: string; domain?: string | null }>): Map<string, string> {
  const owners = new Map<string, string[]>()
  for (const k of knights) {
    if (!k.domain) continue
    const list = owners.get(k.domain)
    if (list) list.push(k.name)
    else owners.set(k.domain, [k.name])
  }
  const index = new Map<string, string>()
  for (const [domain, names] of owners) if (names.length === 1) index.set(domain, names[0])
  return index
}

/** Map domain -> knight name */
export function knightNameForDomain(domainOrName: string): string | null {
  // Direct knight name match first
  if (KNIGHT_CONFIG[domainOrName]) return domainOrName
  // Then try domain lookup
  const entry = Object.entries(KNIGHT_CONFIG).find(([, c]) => c.domain === domainOrName)
  return entry ? entry[0] : null
}
