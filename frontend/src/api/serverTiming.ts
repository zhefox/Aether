export interface ServerTimingMetadata {
  server_now_unix_ms: number
  client_send_unix_ms: number
  client_receive_unix_ms: number
}

export interface ServerTimedPayload {
  server_timing?: ServerTimingMetadata
}

export function beginServerTimingSample(): number {
  return Date.now()
}

export function readServerNowUnixMs(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as { server_now_unix_ms?: unknown }).server_now_unix_ms
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function buildServerTimingMetadata(
  payload: unknown,
  clientSendUnixMs: number,
  clientReceiveUnixMs = Date.now()
): ServerTimingMetadata | undefined {
  const serverNowUnixMs = readServerNowUnixMs(payload)
  if (serverNowUnixMs == null) return undefined
  if (!Number.isFinite(clientSendUnixMs) || !Number.isFinite(clientReceiveUnixMs)) return undefined

  return {
    server_now_unix_ms: serverNowUnixMs,
    client_send_unix_ms: clientSendUnixMs,
    client_receive_unix_ms: clientReceiveUnixMs,
  }
}

export function withServerTiming<T extends object>(payload: T, clientSendUnixMs: number): T & ServerTimedPayload {
  const serverTiming = buildServerTimingMetadata(payload, clientSendUnixMs)
  if (!serverTiming) return payload
  return {
    ...payload,
    server_timing: serverTiming,
  }
}
