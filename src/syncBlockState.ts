/**
 * Blocked-sync overlay decision for the document canvas.
 *
 * While useSync reports anything but synced-remote, tldraw shows its own
 * loader ("Loading tldraw…") with no sense of time — an anonymous reader on a
 * refused sync watches a spinner forever. Past a grace window the app says so
 * itself: first reassurance, then the blocked state with the one safe action
 * (reload). The error screen owns status 'error'; the offline badge owns
 * synced-remote + offline. This covers the rest.
 *
 * Pure by design: the component owns the clock, this owns the thresholds.
 * Ruling-independent by design: the copy names no auth mechanism, so it
 * holds whichever way anonymous sync goes.
 */

export const SYNC_BLOCK_WAIT_MS = 15_000
export const SYNC_BLOCK_BLOCKED_MS = 30_000

export type SyncBlockView = 'waiting' | 'blocked' | null

export function syncBlockView(status: string, elapsedMs: number): SyncBlockView {
  if (status === 'synced-remote' || status === 'error') return null
  if (elapsedMs < SYNC_BLOCK_WAIT_MS) return null
  if (elapsedMs < SYNC_BLOCK_BLOCKED_MS) return 'waiting'
  return 'blocked'
}
