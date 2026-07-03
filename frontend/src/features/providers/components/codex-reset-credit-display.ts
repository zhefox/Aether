import type {
  QuotaResetCreditSnapshot,
  QuotaResetCreditsSnapshot,
} from '@/api/endpoints/types'

export interface CodexResetCreditDisplayItem {
  id?: string | null
  displayKey: string
  expiresAt?: number | null
  remainingSeconds: number
  title: string
}

export function getCodexResetCreditAvailableCount(
  snapshot: QuotaResetCreditsSnapshot | null | undefined,
): number | null {
  const count = snapshot?.available_count
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : null
}

export function formatCodexResetCreditCount(count: number | null | undefined): string {
  return `共 ${count ?? 0} 次机会`
}

function codexResetCreditDisplayKey(item: QuotaResetCreditSnapshot): string | null {
  const explicit = item.display_key?.trim()
  if (explicit) return explicit
  const id = item.id?.trim()
  if (!id) return null
  return id.split('-')[0]?.trim() || null
}

function codexResetCreditRemainingSeconds(
  item: QuotaResetCreditSnapshot,
  snapshot: QuotaResetCreditsSnapshot,
  nowUnixSecs: number,
): number | null {
  if (typeof item.expires_at === 'number' && Number.isFinite(item.expires_at)) {
    return Math.max(item.expires_at - nowUnixSecs, 0)
  }
  if (typeof item.remaining_seconds === 'number' && Number.isFinite(item.remaining_seconds)) {
    const updatedAt = snapshot.updated_at
    const elapsed = typeof updatedAt === 'number' && Number.isFinite(updatedAt)
      ? Math.max(nowUnixSecs - updatedAt, 0)
      : 0
    return Math.max(item.remaining_seconds - elapsed, 0)
  }
  return null
}

function codexResetCreditStatusIsDisplayable(item: QuotaResetCreditSnapshot): boolean {
  const status = item.status?.trim().toLowerCase()
  return !status || status === 'available' || status === 'active'
}

export function getVisibleCodexResetCreditItems(
  snapshot: QuotaResetCreditsSnapshot | null | undefined,
  nowUnixSecs = Math.floor(Date.now() / 1000),
  limit = 5,
): CodexResetCreditDisplayItem[] {
  const credits = snapshot?.credits
  if (!snapshot || !Array.isArray(credits)) return []

  return credits
    .map((item) => {
      if (!codexResetCreditStatusIsDisplayable(item)) return null
      const displayKey = codexResetCreditDisplayKey(item)
      const remainingSeconds = codexResetCreditRemainingSeconds(item, snapshot, nowUnixSecs)
      if (!displayKey || remainingSeconds === null || remainingSeconds <= 0) return null
      return {
        id: item.id,
        displayKey,
        expiresAt: item.expires_at,
        remainingSeconds,
        title: item.id ? `${item.id}` : displayKey,
      } satisfies CodexResetCreditDisplayItem
    })
    .filter((item): item is CodexResetCreditDisplayItem => item !== null)
    .sort((a, b) => a.remainingSeconds - b.remainingSeconds)
    .slice(0, limit)
}

export function formatCodexResetCreditDays(remainingSeconds: number): string {
  const days = Math.max(1, Math.ceil(remainingSeconds / 86_400))
  return `${days}天`
}
