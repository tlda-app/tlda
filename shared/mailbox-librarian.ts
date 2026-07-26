import { createLiveStore } from './live-store.ts'

export type MailboxStatus = 'pending' | 'completed' | 'failed' | 'indeterminate'

export interface MailboxEntry<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  kind: string
  ownerId: string
  status: MailboxStatus
  startedAt: number
  deadlineAt?: number
  meta: TMeta
  result?: Record<string, unknown>
  error?: string
}

export interface MailboxLibrarianOptions {
  now?: () => number
  idGenerator?: () => string
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  onExpire?: (entry: MailboxEntry) => void
}

export interface StartMailboxInput<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  kind: string
  ownerId: string
  timeoutMs?: number
  meta?: TMeta
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000

function defaultMailboxId() {
  const rand = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `mailbox:${String(rand).slice(0, 12)}`
}

export class MailboxLibrarian {
  readonly entries = createLiveStore<MailboxEntry>()
  private readonly now: () => number
  private readonly idGenerator: () => string
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly onExpire?: (entry: MailboxEntry) => void
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(opts: MailboxLibrarianOptions = {}) {
    this.now = opts.now ?? Date.now
    this.idGenerator = opts.idGenerator ?? defaultMailboxId
    this.setTimer = opts.setTimeoutFn ?? setTimeout
    this.clearTimer = opts.clearTimeoutFn ?? clearTimeout
    this.onExpire = opts.onExpire
  }

  start<TMeta extends Record<string, unknown> = Record<string, unknown>>(input: StartMailboxInput<TMeta>): MailboxEntry<TMeta> {
    const startedAt = this.now()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const entry: MailboxEntry<TMeta> = {
      id: this.idGenerator(),
      kind: input.kind,
      ownerId: input.ownerId,
      status: 'pending',
      startedAt,
      deadlineAt: timeoutMs > 0 ? startedAt + timeoutMs : undefined,
      meta: (input.meta || {}) as TMeta,
    }
    this.entries.upsert(entry)
    if (timeoutMs > 0) {
      const timer = this.setTimer(() => {
        const current = this.entries.get(entry.id)
        if (!current || current.status !== 'pending') return
        const expired = { ...current, status: 'failed' as const, error: 'deadline exceeded' }
        this.entries.upsert(expired)
        this.timers.delete(entry.id)
        this.onExpire?.(expired)
      }, timeoutMs)
      this.timers.set(entry.id, timer)
    }
    return entry
  }

  complete(id: string, result: Record<string, unknown> = {}): MailboxEntry | null {
    return this.settle(id, 'completed', { result })
  }

  fail(id: string, error: string, result: Record<string, unknown> = {}): MailboxEntry | null {
    return this.settle(id, 'failed', { error, result })
  }

  indeterminate(id: string, error: string, result: Record<string, unknown> = {}): MailboxEntry | null {
    return this.settle(id, 'indeterminate', { error, result })
  }

  get(id: string): MailboxEntry | undefined {
    return this.entries.get(id)
  }

  private settle(id: string, status: MailboxStatus, patch: { result?: Record<string, unknown>; error?: string }): MailboxEntry | null {
    const current = this.entries.get(id)
    if (!current || current.status !== 'pending') return null
    const timer = this.timers.get(id)
    if (timer) {
      this.clearTimer(timer)
      this.timers.delete(id)
    }
    const settled = { ...current, status, ...patch }
    this.entries.upsert(settled)
    return settled
  }
}
