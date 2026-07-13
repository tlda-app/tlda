type UiIntentPhase =
  | 'intent-start'
  | 'valid-target'
  | 'drop'
  | 'mutation-request'
  | 'mutation-commit'
  | 'render-confirmed'
  | 'failure'

type UiIntentDetail = Record<string, unknown>

type UiIntentProbe = {
  recordEvent?: (type: string, detail?: UiIntentDetail) => void
}

const DROP_TO_MUTATION_REQUEST_MS = 250
const MUTATION_REQUEST_TO_COMMIT_MS = 500
const MUTATION_COMMIT_TO_RENDER_MS = 1000

let nextIntentSequence = 0

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function liveProbe(): UiIntentProbe | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { __livePerfProbe?: UiIntentProbe }).__livePerfProbe || null
}

function emit(detail: UiIntentDetail) {
  try {
    liveProbe()?.recordEvent?.('ui-intent', detail)
  } catch {
    // Telemetry must never throw into interaction code.
  }
}

function timeout(fn: () => void, ms: number): number | null {
  if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return null
  return window.setTimeout(fn, ms)
}

function clearTimer(timer: number | null) {
  if (timer == null || typeof window === 'undefined') return
  window.clearTimeout(timer)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function hashUiIntentState(value: unknown): string {
  const text = canonicalJson(value)
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export class UiIntentTransaction {
  readonly intentId: string
  readonly action: string
  readonly startedAtMs: number
  private enabled: boolean
  private common: UiIntentDetail
  private currentPhase: UiIntentPhase = 'intent-start'
  private timer: number | null = null
  private terminal = false

  constructor(action: string, common: UiIntentDetail = {}) {
    nextIntentSequence += 1
    this.intentId = `${Date.now().toString(36)}-${nextIntentSequence.toString(36)}`
    this.action = action
    this.enabled = typeof liveProbe()?.recordEvent === 'function'
    this.common = { ...common }
    this.startedAtMs = nowMs()
    this.record('intent-start', common)
  }

  validTarget(detail: UiIntentDetail = {}) {
    this.record('valid-target', detail)
  }

  drop(detail: UiIntentDetail = {}) {
    this.record('drop', detail)
    this.expect('mutation-request', 'no-mutation', DROP_TO_MUTATION_REQUEST_MS)
  }

  mutationRequest(detail: UiIntentDetail = {}) {
    this.record('mutation-request', detail)
    this.expect('mutation-commit', 'no-state-change', MUTATION_REQUEST_TO_COMMIT_MS)
  }

  mutationCommit(detail: UiIntentDetail = {}) {
    this.record('mutation-commit', detail)
    this.expect('render-confirmed', 'render-timeout', MUTATION_COMMIT_TO_RENDER_MS)
  }

  renderConfirmed(detail: UiIntentDetail = {}) {
    this.record('render-confirmed', detail)
    this.terminal = true
    clearTimer(this.timer)
    this.timer = null
  }

  failure(failureReason: string, detail: UiIntentDetail = {}) {
    this.record('failure', { ...detail, failureReason })
    this.terminal = true
    clearTimer(this.timer)
    this.timer = null
  }

  private record(phase: UiIntentPhase, detail: UiIntentDetail = {}) {
    if (this.terminal && phase !== 'failure') return
    this.currentPhase = phase
    if (!this.enabled) return
    emit({
      ...this.common,
      ...detail,
      intentId: this.intentId,
      action: this.action,
      phase,
      elapsedMs: Math.round(nowMs() - this.startedAtMs),
    })
  }

  private expect(phase: UiIntentPhase, failureReason: string, ms: number) {
    if (!this.enabled) return
    clearTimer(this.timer)
    this.timer = timeout(() => {
      if (this.terminal || this.currentPhase === phase) return
      this.failure(failureReason, { expectedPhase: phase })
    }, ms)
  }
}

export function beginUiIntent(action: string, common: UiIntentDetail = {}) {
  return new UiIntentTransaction(action, common)
}
