import { createLiveStore } from './live-store.ts'
import { canonicalModel, classifyModel, normalizeKind, type Kind } from './harness.ts'

export type LivenessState = 'alive' | 'dead' | 'spawning' | 'wedged' | 'unknown'
export type SpawnFailureReason = 'launch-failed' | 'register-timeout' | 'policy-denied' | 'name-bounced'

export interface AgentRecord {
  id: string
  friendly_name?: string | null
  dead?: boolean
  human?: boolean
  cwd?: string | null
  tmux_session?: string | null
  metadata?: Record<string, unknown> | null
  kind?: string | null
}

export interface SpawnSpec {
  model?: string | null
  kind?: string | null
  project?: string | null
}

export interface PendingSpawn {
  id: string
  name: string
  spec: SpawnSpec
  startedAt: number
  deadlineAt: number
}

export type SpawnResult =
  | { ok: true; agent: AgentRecord }
  | { ok: false; reason: SpawnFailureReason }

export interface AgentLivenessEvent {
  type?: 'agent-liveness'
  agent_id: string
  tmux_session?: string | null
  state: LivenessState
  pid?: number
  reason?: string
  ts?: string
}

export interface AgentActivityEvent {
  type?: 'agent-activity'
  agent_id: string
  jsonl_offset: number
  ts?: string
}

export type WakeDecision =
  | { action: 'deliver' }
  | { action: 'queue'; reason: 'spawning' }
  | { action: 'hold'; reason: 'unknown' }
  | { action: 'respawn' }
  | { action: 'surface'; reason: 'wedged'; message: string }

export class SpawnBounceError extends Error {
  readonly reason = 'name-bounced' as const
  readonly payload: Record<string, unknown>

  constructor(message: string, payload: Record<string, unknown>) {
    super(message)
    this.name = 'SpawnBounceError'
    this.payload = payload
  }
}

export interface SpawnBounceItem {
  id: string
  kind: 'bounce'
  from: string
  title: string
  body: string
  actions: Array<{
    label: 'pick-another' | 'respawn'
    command: string
    target: string
    clientAction: 'pick-another' | 'respawn'
  }>
  present: { chat: true; hud: true }
  priority: 'high'
}

export interface SpawnBounceItemInput {
  userId: string
  agentId: string
  title: string
  body: string
  pickAnotherCommand: string
  respawnCommand: string
}

export function buildSpawnBounceItem(input: SpawnBounceItemInput): SpawnBounceItem {
  return {
    id: `spawn-bounce:${input.agentId}`,
    kind: 'bounce',
    from: input.agentId,
    title: input.title,
    body: input.body,
    actions: [
      {
        label: 'pick-another',
        command: input.pickAnotherCommand,
        target: input.userId,
        clientAction: 'pick-another',
      },
      {
        label: 'respawn',
        command: input.respawnCommand,
        target: input.userId,
        clientAction: 'respawn',
      },
    ],
    present: { chat: true, hud: true },
    priority: 'high',
  }
}

export function raiseSpawnBounceItem(
  raiseItem: (userId: string, item: SpawnBounceItem) => void,
  input: SpawnBounceItemInput
): SpawnBounceItem {
  const item = buildSpawnBounceItem(input)
  raiseItem(input.userId, item)
  return item
}

interface PendingWaiter {
  resolve: (result: SpawnResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface DeliveryWait {
  deliveredAt: number
  timer: ReturnType<typeof setTimeout>
}

export interface SpawnLibrarianOptions {
  registerDeadlineMs?: number
  wedgedWindowMs?: number
  now?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  onWedged?: (event: { agent_id: string; deliveredAt: number; liveness?: AgentLivenessEvent }) => void
  onLateRegister?: (agent: AgentRecord) => void
}

// TTL for the timed-out-id set: if an agent registers this long after the deadline
// it's far enough past the spawn context that no notification is useful.
const LATE_REGISTER_TTL_MS = 5 * 60_000

export class SpawnLibrarian {
  readonly pendingSpawns = createLiveStore<PendingSpawn>()
  private readonly registerDeadlineMs: number
  private readonly wedgedWindowMs: number
  private readonly now: () => number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly onWedged?: SpawnLibrarianOptions['onWedged']
  private readonly onLateRegister?: SpawnLibrarianOptions['onLateRegister']
  private readonly waiters = new Map<string, PendingWaiter>()
  private readonly liveness = new Map<string, AgentLivenessEvent>()
  private readonly lastActivity = new Map<string, AgentActivityEvent>()
  private readonly pendingDeliveries = new Map<string, DeliveryWait>()
  // IDs whose awaitRegister fired register-timeout; watched for late arrival.
  private readonly timedOutIds = new Map<string, number>()

  constructor(opts: SpawnLibrarianOptions = {}) {
    this.registerDeadlineMs = opts.registerDeadlineMs ?? 60_000
    this.wedgedWindowMs = opts.wedgedWindowMs ?? 90_000
    this.now = opts.now ?? Date.now
    this.setTimer = opts.setTimeoutFn ?? setTimeout
    this.clearTimer = opts.clearTimeoutFn ?? clearTimeout
    this.onWedged = opts.onWedged
    this.onLateRegister = opts.onLateRegister
  }

  awaitRegister(input: { id: string; name: string; spec?: SpawnSpec }): Promise<SpawnResult> {
    const startedAt = this.now()
    const pending: PendingSpawn = {
      id: input.id,
      name: input.name,
      spec: input.spec || {},
      startedAt,
      deadlineAt: startedAt + this.registerDeadlineMs,
    }
    this.pendingSpawns.upsert(pending)
    return new Promise((resolve) => {
      const timer = this.setTimer(() => {
        this.waiters.delete(input.id)
        this.pendingSpawns.remove(input.id)
        this.timedOutIds.set(input.id, this.now())
        resolve({ ok: false, reason: 'register-timeout' })
      }, this.registerDeadlineMs)
      this.waiters.set(input.id, { resolve, timer })
    })
  }

  observeRegister(agent: AgentRecord): void {
    const waiter = this.waiters.get(agent.id)
    if (waiter) {
      this.clearTimer(waiter.timer)
      this.waiters.delete(agent.id)
      this.pendingSpawns.remove(agent.id)
      waiter.resolve({ ok: true, agent })
      return
    }
    // No active waiter — check if this is a late registration after timeout.
    const timedOutAt = this.timedOutIds.get(agent.id)
    if (timedOutAt !== undefined) {
      this.timedOutIds.delete(agent.id)
      if (this.now() - timedOutAt < LATE_REGISTER_TTL_MS) {
        this.onLateRegister?.(agent)
      }
    }
    // Sweep stale timed-out entries while we're here.
    const cutoff = this.now() - LATE_REGISTER_TTL_MS
    for (const [id, ts] of this.timedOutIds) {
      if (ts < cutoff) this.timedOutIds.delete(id)
    }
  }

  failPending(id: string, reason: SpawnFailureReason): void {
    const waiter = this.waiters.get(id)
    if (!waiter) return
    this.clearTimer(waiter.timer)
    this.waiters.delete(id)
    this.pendingSpawns.remove(id)
    waiter.resolve({ ok: false, reason })
  }

  observeLiveness(event: AgentLivenessEvent): void {
    if (!event.agent_id) return
    this.liveness.set(event.agent_id, event)
  }

  observeActivity(event: AgentActivityEvent): void {
    if (!event.agent_id) return
    const prev = this.lastActivity.get(event.agent_id)
    if (!prev || event.jsonl_offset > prev.jsonl_offset) {
      this.lastActivity.set(event.agent_id, event)
      const pending = this.pendingDeliveries.get(event.agent_id)
      const activityAt = event.ts ? Date.parse(event.ts) : this.now()
      if (pending && activityAt > pending.deliveredAt) {
        this.clearTimer(pending.timer)
        this.pendingDeliveries.delete(event.agent_id)
      }
    }
    this.observeLiveness({ type: 'agent-liveness', agent_id: event.agent_id, state: 'alive', ts: event.ts })
  }

  observeDelivery(agentId: string, deliveredAt = this.now()): void {
    const previous = this.pendingDeliveries.get(agentId)
    if (previous) this.clearTimer(previous.timer)
    const timer = this.setTimer(() => {
      const pending = this.pendingDeliveries.get(agentId)
      if (!pending || pending.deliveredAt !== deliveredAt) return
      const live = this.liveness.get(agentId)
      if (live?.state !== 'alive') return
      this.pendingDeliveries.delete(agentId)
      const wedged = { ...live, state: 'wedged' as const, reason: 'delivered chat produced no agent-activity advance' }
      this.liveness.set(agentId, wedged)
      this.onWedged?.({ agent_id: agentId, deliveredAt, liveness: wedged })
    }, this.wedgedWindowMs)
    this.pendingDeliveries.set(agentId, { deliveredAt, timer })
  }

  livenessState(agentId: string): LivenessState | undefined {
    return this.liveness.get(agentId)?.state
  }

  decideWake(agent: AgentRecord, checked?: AgentLivenessEvent | null, opts: { serverAlive?: boolean } = {}): WakeDecision {
    if (opts.serverAlive === false) return { action: 'respawn' }
    const state = checked?.state || this.liveness.get(agent.id)?.state || (agent.dead ? 'dead' : 'unknown')
    if (state === 'alive') return { action: 'deliver' }
    if (state === 'spawning') return { action: 'queue', reason: 'spawning' }
    if (state === 'unknown') return { action: 'hold', reason: 'unknown' }
    if (state === 'dead') return { action: 'respawn' }
    return {
      action: 'surface',
      reason: 'wedged',
      message: checked?.reason || this.liveness.get(agent.id)?.reason || 'agent process is up but not processing delivered messages',
    }
  }
}

export function specMismatch(
  requested: SpawnSpec,
  agent: AgentRecord,
  opts: { projectForCwd?: (cwd?: string | null) => string | null } = {}
): boolean {
  const meta = (agent.metadata || {}) as Record<string, unknown>
  const requestedModel = requested.model ? canonicalModel(requested.model, requested.kind) : null
  const existingModel = meta.model ? canonicalModel(meta.model as string, meta.kind as string | undefined) : null
  if (requestedModel && existingModel && requestedModel !== existingModel) return true

  const requestedKind = requested.kind
    ? normalizeKind(requested.kind, classifyModel({ model: requested.model }).family as Kind)
    : null
  const existingKind = meta.kind ? normalizeKind(meta.kind as string, classifyModel({ model: meta.model }).family as Kind) : null
  if (requestedKind && existingKind && requestedKind !== existingKind) return true

  const requestedProject = requested.project || null
  const existingProject = opts.projectForCwd?.(agent.cwd) || null
  if (requestedProject && existingProject && requestedProject !== existingProject) return true
  return false
}

export function describeAgentSpec(
  agent: AgentRecord,
  opts: { projectForCwd?: (cwd?: string | null) => string | null } = {}
): string {
  const meta = (agent.metadata || {}) as Record<string, unknown>
  const model = typeof meta.model === 'string' ? meta.model : '?'
  const project = opts.projectForCwd?.(agent.cwd) || agent.cwd || '?'
  return `${model}/${project}`
}

export function describeRequestedSpec(requested: SpawnSpec): string {
  return `${requested.model || '?'}/${requested.project || '?'}`
}

export function resolveSpawnCollision(input: {
  name: string
  respawn: boolean
  fresh?: boolean
  requested?: SpawnSpec
  liveMatches: readonly AgentRecord[]
  projectForCwd?: (cwd?: string | null) => string | null
}): { name: string; respawn: boolean; existing?: AgentRecord } {
  const { name, respawn, fresh = false, liveMatches } = input
  if (respawn || !name) return { name, respawn }
  if (fresh) return { name, respawn: false }
  const live = liveMatches.filter((a) => !a.dead)
  if (live.length === 0) return { name, respawn }
  if (live.length > 1) return { name, respawn }
  const existing = live[0]
  if (!existing) return { name, respawn }
  return { name: existing.id, respawn: true, existing }
}
