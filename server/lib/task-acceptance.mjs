const FINGERPRINT_FIELDS = ['agent_id', 'session_id', 'daemon_key', 'terminal_capability', 'activated_at']

function requiredFingerprint(seat, agentId) {
  const fingerprint = { agent_id: agentId }
  for (const field of FINGERPRINT_FIELDS.slice(1)) {
    if (seat?.[field] == null || seat[field] === '') throw new Error(`current durable seat has no ${field}`)
    fingerprint[field] = seat[field]
  }
  return fingerprint
}

function sameFingerprint(left, right) {
  return FINGERPRINT_FIELDS.every(field => left?.[field] === right?.[field])
}

export async function acceptTaskResponsibility({
  fleetStore, taskId, callerAgentId, callerSessionId, operationId,
  now = new Date().toISOString(),
}) {
  if (!fleetStore) throw new Error('missing fleet store')
  if (!taskId) throw new Error('missing task id')
  if (!callerAgentId) throw new Error('missing caller agent')
  if (!callerSessionId) throw new Error('missing caller session')
  if (!operationId) throw new Error('missing acceptance operation id')

  const task = fleetStore.getTask?.(taskId)
  if (!task) throw new Error('task not found or no longer active')
  if (task.agent !== callerAgentId) throw new Error('task is assigned to another agent')

  const currentFingerprint = requiredFingerprint(
    fleetStore.getCurrentAgentSeat?.(callerAgentId), callerAgentId,
  )
  if (currentFingerprint.session_id !== callerSessionId) throw new Error('caller session does not own the current durable seat')

  const existing = task.metadata?.task_acceptance
  if (existing) {
    if (!task.acknowledged || task.status !== 'working') throw new Error('task acceptance record is inconsistent with task state')
    return { ok: true, idempotent: true, task, acceptance: existing, event_id: existing.event_id || null }
  }

  if (task.status !== 'pending') throw new Error(`task must be pending before acceptance (current: ${task.status || 'unknown'})`)
  if (task.acknowledged) throw new Error('task is acknowledged without an acceptance record')

  if (typeof fleetStore.acceptTaskAtomically !== 'function') throw new Error('fleet store has no atomic task acceptance writer')
  try {
    const { task: readback, event } = await fleetStore.acceptTaskAtomically({
      task, fingerprint: currentFingerprint, operationId, acceptedAt: now,
    })
    if (!sameFingerprint(readback.metadata?.task_acceptance?.fingerprint, currentFingerprint)) {
      throw new Error('atomic task acceptance fingerprint readback failed')
    }
    return { ok: true, idempotent: false, task: readback, acceptance: readback.metadata.task_acceptance, event_id: event.id }
  } catch (error) {
    const recovered = fleetStore.getTask?.(taskId)
    const recoveredAcceptance = recovered?.metadata?.task_acceptance
    if (recovered?.agent === callerAgentId && recovered?.acknowledged && recovered.status === 'working' && recoveredAcceptance?.event_id != null) {
      return { ok: true, idempotent: true, task: recovered, acceptance: recoveredAcceptance, event_id: recoveredAcceptance.event_id }
    }
    throw error
  }
}
