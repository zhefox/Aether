import { describe, expect, it } from 'vitest'
import { calculateServerClockOffsetMs, useServerClock } from '../useServerClock'

describe('useServerClock', () => {
  it('calculates offset from the request midpoint', () => {
    const offset = calculateServerClockOffsetMs({
      server_now_unix_ms: 10_500,
      client_send_unix_ms: 20_000,
      client_receive_unix_ms: 20_200,
    })

    expect(offset).toBe(-9_600)
  })

  it('ignores missing or invalid timing samples', () => {
    expect(calculateServerClockOffsetMs(undefined)).toBeNull()
    expect(calculateServerClockOffsetMs({
      server_now_unix_ms: Number.NaN,
      client_send_unix_ms: 20_000,
      client_receive_unix_ms: 20_200,
    })).toBeNull()
    expect(calculateServerClockOffsetMs({
      server_now_unix_ms: 10_500,
      client_send_unix_ms: 20_200,
      client_receive_unix_ms: 20_000,
    })).toBeNull()
  })

  it('keeps the previous offset when a response has no server timing', () => {
    const clock = useServerClock()

    clock.updateServerClockOffset({
      server_now_unix_ms: 10_500,
      client_send_unix_ms: 20_000,
      client_receive_unix_ms: 20_200,
    })
    clock.updateServerClockOffset(undefined)

    expect(clock.hasServerClockOffset.value).toBe(true)
    expect(clock.serverClockOffsetMs.value).toBe(-9_600)
  })
})
