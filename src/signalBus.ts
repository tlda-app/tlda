/**
 * Generic signal dispatch for Yjs-backed and ephemeral signals.
 *
 * Two dispatch paths:
 * - dispatch(): from Yjs observe — handles timestamp guards, init behavior, CRDT dedup
 * - dispatchDirect(): from ephemeral 0x03 broadcast — fires callbacks immediately, no CRDT
 */

export interface SignalDef<T> {
  key: string
  /** Filter: return false to suppress dispatch (e.g. own-viewer check) */
  accept?: (signal: T) => boolean
  /** What to do during initial sync. Default: 'discard' (record timestamp only). */
  initBehavior?: 'discard' | 'fire-if-recent'
  /** For 'fire-if-recent': max age in ms to still fire during init. Default 10000. */
  recentMs?: number
}

interface HandlerState<T> {
  def: SignalDef<T>
  lastTimestamp: number
  callbacks: Set<(signal: T) => void>
}

export class SignalBus {
  private handlers = new Map<string, HandlerState<any>>()

  register<T extends { timestamp: number }>(def: SignalDef<T>) {
    const state: HandlerState<T> = {
      def,
      lastTimestamp: 0,
      callbacks: new Set(),
    }
    this.handlers.set(def.key, state)

    return {
      on: (cb: (signal: T) => void): (() => void) => {
        state.callbacks.add(cb)
        return () => { state.callbacks.delete(cb) }
      },
    }
  }

  /**
   * Direct dispatch for ephemeral (0x03) signals — no CRDT guards, no timestamp dedup.
   * Fires all registered callbacks immediately.
   */
  dispatchDirect(key: string, data: Record<string, unknown>): void {
    const state = this.handlers.get(key)
    if (!state) return
    const signal = data as { timestamp: number }
    if (!signal?.timestamp) return
    if (state.def.accept && !state.def.accept(signal)) return
    state.lastTimestamp = signal.timestamp
    for (const cb of state.callbacks) cb(signal)
  }

  /**
   * Called from yRecords.observe() for each changed key.
   * Handles timestamp guards, init behavior, accept filters, and callback dispatch.
   */
  dispatch(key: string, action: string, getValue: () => unknown, isInit: boolean): void {
    if (action !== 'add' && action !== 'update') return

    const state = this.handlers.get(key)
    if (!state) return

    const signal = getValue() as { timestamp: number } | null
    if (!signal?.timestamp) return

    if (isInit) {
      const { initBehavior = 'discard', recentMs = 10000 } = state.def
      if (initBehavior === 'fire-if-recent' && Date.now() - signal.timestamp < recentMs) {
        state.lastTimestamp = signal.timestamp
        for (const cb of state.callbacks) cb(signal)
      } else {
        state.lastTimestamp = signal.timestamp
      }
      return
    }

    if (signal.timestamp <= state.lastTimestamp) return
    if (state.def.accept && !state.def.accept(signal)) {
      // Still update timestamp even if filtered, so we don't re-fire on next change
      state.lastTimestamp = signal.timestamp
      return
    }

    state.lastTimestamp = signal.timestamp
    for (const cb of state.callbacks) cb(signal)
  }
}
