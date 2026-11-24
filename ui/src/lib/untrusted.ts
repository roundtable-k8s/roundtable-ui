// Helpers for rendering attacker-influenced content (model output, tool
// arguments/output, logs, results) safely (#188).

// ANSI CSI/OSC/other escape sequences.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
// C0/C1 control characters except \t \n; \r is folded into \n; plus bidi overrides.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** Strips ANSI escape sequences and control characters; keeps tab/newline. */
export function sanitizeText(input: unknown): string {
  if (input == null) return ''
  const s = typeof input === 'string' ? input : String(input)
  return s.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '')
}

const SAFE_LINK_SCHEMES = new Set(['http:', 'https:'])

/** Link allowlist for markdown: only absolute http(s) URLs (and in-page/relative paths) pass. */
export function safeUrl(url: string | undefined): string {
  if (!url) return ''
  const trimmed = url.trim()
  if (trimmed.startsWith('#') || (trimmed.startsWith('/') && !trimmed.startsWith('//'))) return trimmed
  try {
    const u = new URL(trimmed)
    return SAFE_LINK_SCHEMES.has(u.protocol) ? trimmed : ''
  } catch {
    return ''
  }
}
