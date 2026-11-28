import { describe, it, expect } from 'vitest'
import { mapLimit } from './mapLimit'

describe('mapLimit', () => {
  it('never exceeds the limit and keeps order', async () => {
    let inFlight = 0
    let peak = 0
    const res = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      if (n === 3) throw new Error('boom')
      return n * 2
    })
    expect(peak).toBe(4)
    expect(res[0]).toEqual({ status: 'fulfilled', value: 2 })
    expect(res[2].status).toBe('rejected')
    expect(res[8]).toEqual({ status: 'fulfilled', value: 18 })
  })

  it('handles empty input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
