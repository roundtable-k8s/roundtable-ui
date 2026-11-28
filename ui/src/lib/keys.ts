/**
 * `namespace/name` identity of a namespaced resource. A missing namespace gives
 * a leading slash (`/name`), so keys stay unambiguous in maps.
 *
 * `lib/chat.ts` keeps its own `knightKey` on purpose: chat keys are also user-facing
 * option values and labels, so they omit the slash when there is no namespace.
 */
export function namespacedKey(o: { namespace?: string; name: string }): string {
  return `${o.namespace ?? ''}/${o.name}`
}
