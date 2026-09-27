// Pure read-model for the spawn-mailbox wait handle: turns a mailbox entry (or
// its absence) into the status a mint caller polls. No store import — the
// caller injects findAgent for the completed cross-check, and nowMs for time.

export const MAILBOX_DEADLINE_EXCEEDED = 'deadline exceeded'

function pendingShell(row) {
  if (!row || row.dead) return false
  const shell = row.metadata?.shell
  return shell === true || shell === 1
}

export async function buildSpawnMailboxStatus(entry, { findAgent = null, nowMs = Date.now() } = {}) {
  if (!entry) {
    return { status: 'unknown' }
  }
  const meta = entry.meta || {}
  const result = entry.result || {}
  const base = {
    mailbox_id: entry.id,
    status: entry.status,
    kind: entry.kind || null,
    agent_id: result.agentId || result.agent_id || meta.agentId || null,
    requested_name: result.requested_name || meta.name || null,
    started_at: entry.startedAt ? new Date(entry.startedAt).toISOString() : null,
    deadline_at: entry.deadlineAt ? new Date(entry.deadlineAt).toISOString() : null,
    waited_ms: entry.startedAt != null ? Math.max(0, nowMs - entry.startedAt) : null,
    remaining_ms: entry.deadlineAt != null ? Math.max(0, entry.deadlineAt - nowMs) : null,
  }
  if (entry.status === 'pending') {
    return base
  }
  if (entry.status === 'completed') {
    const live = await describeLiveRow(base.agent_id, findAgent)
    return {
      ...base,
      assigned_name: result.assigned_name || result.label || null,
      name_changed: result.name_changed ?? null,
      task_id: result.task_id || null,
      delegate_event_id: result.delegate_event_id || null,
      live,
    }
  }
  // P2: expiry is its own status now; the failed+deadline shape is kept for
  // entries that expired before the deploy (memory-only, so it vanishes on
  // restart — the disjunct costs nothing and misreads nothing).
  const expired = entry.status === 'expired' || (entry.status === 'failed' && entry.error === MAILBOX_DEADLINE_EXCEEDED)
  return {
    ...base,
    error: entry.error || null,
    reason: expired ? 'deadline-exceeded' : (result.reason || null),
    expired: (entry.status === 'failed' || entry.status === 'expired') ? expired : false,
  }
}

async function describeLiveRow(agentId, findAgent) {
  if (!agentId || typeof findAgent !== 'function') return null
  let row = null
  try {
    row = await findAgent(agentId)
  } catch {
    return null
  }
  if (!row) return { state: 'missing' }
  if (row.dead) return { state: 'dead', name: row.friendly_name || null }
  return { state: 'live', name: row.friendly_name || null, pending: pendingShell(row) }
}
