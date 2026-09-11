import { log } from './logger.ts'

type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function appBadgeSupported(nav: Partial<BadgingNavigator> | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return typeof nav?.setAppBadge === 'function' && typeof nav?.clearAppBadge === 'function'
}

export function badgeCountFor(unreadEvents: number): number {
  return Number.isFinite(unreadEvents) && unreadEvents > 0 ? Math.floor(unreadEvents) : 0
}

export function coalesceAsyncRefresh(refresh: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let queued = false

  return () => {
    if (running) {
      queued = true
      return running
    }
    running = (async () => {
      do {
        queued = false
        await refresh()
      } while (queued)
    })().finally(() => { running = null })
    return running
  }
}

export async function applyAppBadge(
  unreadEvents: number,
  nav: Partial<BadgingNavigator> | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<'set' | 'cleared' | 'unsupported' | 'failed'> {
  if (!appBadgeSupported(nav)) return 'unsupported'
  const count = badgeCountFor(unreadEvents)
  try {
    if (count === 0) {
      await nav!.clearAppBadge!()
      return 'cleared'
    }
    await nav!.setAppBadge!(count)
    return 'set'
  } catch (err) {
    log.debug('app-badge', 'badge update rejected', {
      count,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'failed'
  }
}
