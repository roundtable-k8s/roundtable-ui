/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results keep the
 * input order and every item settles (like Promise.allSettled), so one failing
 * call never stops the rest.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return results
}

/** Concurrent introspect requests the Dashboard and Sessions views allow (#633). */
export const INTROSPECT_CONCURRENCY = 4
