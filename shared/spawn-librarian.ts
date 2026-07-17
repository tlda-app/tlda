import { createLiveStore } from './live-store.ts'
export type LivenessState = 'alive' | 'dead' | 'spawning' | 'wedged' | 'unknown'
export type SpawnFailureReason = 'launch-failed' | 'policy-denied' | 'name-bounced'

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
}

export interface SpawnLibrarianOptions {
  loginDeadlineMs?: number
  now?: () => number
}

export class SpawnLibrarian {
  readonly pendingSpawns = createLiveStore<PendingSpawn>()
  private readonly loginDeadlineMs: number
  private readonly now: () => number
  private readonly waiters = new Map<string, PendingWaiter>()
  private readonly liveness = new Map<string, AgentLivenessEvent>()
  private readonly lastActivity = new Map<string, AgentActivityEvent>()

  constructor(opts: SpawnLibrarianOptions = {}) {
    this.loginDeadlineMs = opts.loginDeadlineMs ?? 60_000
    this.now = opts.now ?? Date.now
  }

  awaitLogin(input: { id: string; name: string; spec?: SpawnSpec }): Promise<SpawnResult> {
    const startedAt = this.now()
    const pending: PendingSpawn = {
      id: input.id,
      name: input.name,
      spec: input.spec || {},
      startedAt,
      deadlineAt: startedAt + this.loginDeadlineMs,
    }
    this.pendingSpawns.upsert(pending)
    return new Promise((resolve) => {
      this.waiters.set(input.id, { resolve })
    })
  }

  observeLogin(agent: AgentRecord): void {
    const waiter = this.waiters.get(agent.id)
    if (waiter) {
      this.waiters.delete(agent.id)
      this.pendingSpawns.remove(agent.id)
      waiter.resolve({ ok: true, agent })
    }
  }

  failPending(id: string, reason: SpawnFailureReason): void {
    const waiter = this.waiters.get(id)
    if (!waiter) return
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
    }
    this.observeLiveness({ type: 'agent-liveness', agent_id: event.agent_id, state: 'alive', ts: event.ts })
  }

  livenessState(agentId: string): LivenessState | undefined {
    return this.liveness.get(agentId)?.state
  }

  decideWake(agent: AgentRecord, checked?: AgentLivenessEvent | null, opts: { serverAlive?: boolean } = {}): WakeDecision {
    if (opts.serverAlive === false) return { action: 'respawn' }
    if (opts.serverAlive === true) return { action: 'deliver' }
    const state = checked?.state || this.liveness.get(agent.id)?.state || (agent.dead ? 'dead' : 'unknown')
    if (state === 'alive') return { action: 'deliver' }
    if (state === 'spawning') return { action: 'queue', reason: 'spawning' }
    if (state === 'unknown') return { action: 'hold', reason: 'unknown' }
    if (state === 'dead') return { action: 'respawn' }
    return {
      action: 'surface',
      reason: 'wedged',
      message: checked?.reason || this.liveness.get(agent.id)?.reason || 'agent process is up but not processing attempted messages',
    }
  }
}

export function specMismatch(
  requested: SpawnSpec,
  agent: AgentRecord,
  opts: { projectForCwd?: (cwd?: string | null) => string | null } = {}
): boolean {
  const meta = (agent.metadata || {}) as Record<string, unknown>
  const requestedModel = requested.model ? String(requested.model).trim() : null
  const existingModel = meta.model ? String(meta.model).trim() : null
  if (requestedModel && existingModel && requestedModel !== existingModel) return true

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
