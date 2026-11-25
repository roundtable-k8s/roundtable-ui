/** Link to a trace in the configured viewer, or null when either input is unusable. */
export function traceUrl(template: string | undefined | null, traceId: string | undefined | null): string | null {
  if (!template || !traceId) return null
  if (!/^[0-9a-fA-F]{32}$/.test(traceId)) return null
  if (!/^https?:\/\//i.test(template) || !template.includes('{traceId}')) return null
  return template.split('{traceId}').join(traceId)
}
