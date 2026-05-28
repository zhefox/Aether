import { ref } from 'vue'
import type { ServerTimingMetadata } from '@/api/serverTiming'

export function calculateServerClockOffsetMs(timing: ServerTimingMetadata | null | undefined): number | null {
  if (!timing) return null
  const { server_now_unix_ms: serverNowUnixMs, client_send_unix_ms: clientSendUnixMs, client_receive_unix_ms: clientReceiveUnixMs } = timing

  if (!Number.isFinite(serverNowUnixMs) || !Number.isFinite(clientSendUnixMs) || !Number.isFinite(clientReceiveUnixMs)) {
    return null
  }
  if (clientReceiveUnixMs < clientSendUnixMs) {
    return null
  }

  const clientMidpointUnixMs = clientSendUnixMs + ((clientReceiveUnixMs - clientSendUnixMs) / 2)
  return serverNowUnixMs - clientMidpointUnixMs
}

export function useServerClock() {
  const serverClockOffsetMs = ref(0)
  const hasServerClockOffset = ref(false)

  function updateServerClockOffset(timing: ServerTimingMetadata | null | undefined): void {
    const offsetMs = calculateServerClockOffsetMs(timing)
    if (offsetMs == null) return

    serverClockOffsetMs.value = offsetMs
    hasServerClockOffset.value = true
  }

  return {
    serverClockOffsetMs,
    hasServerClockOffset,
    updateServerClockOffset,
  }
}
