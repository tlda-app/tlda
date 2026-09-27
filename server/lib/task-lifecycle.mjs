export async function completeTaskLifecycle({
  fleetStore,
  agentId,
  task,
  description = task?.description,
  completedAt = new Date().toISOString(),
  eventMetadata,
  taskMetadataPatch,
  onCompleted,
}) {
  if (!fleetStore) throw new Error('missing fleetStore')
  if (!agentId) throw new Error('missing agentId')
  if (!task?.id) throw new Error('missing task')

  const completedTask = {
    ...task,
    status: 'done',
    completed_at: completedAt,
  }
  if (taskMetadataPatch && Object.keys(taskMetadataPatch).length > 0) {
    completedTask.metadata = { ...(task.metadata || {}), ...taskMetadataPatch }
  }

  await fleetStore.upsertTask(completedTask)
  onCompleted?.(agentId)
  const event = await fleetStore.taskDone?.(agentId, completedTask.id, description, eventMetadata)
  return {
    task: completedTask,
    event: event || null,
    eventId: event?.id || null,
  }
}

export function appendDelegationMessage(task, {
  fromAgentId = null,
  toAgentId,
  message,
  delegatedAt = new Date().toISOString(),
}) {
  if (!task?.id) throw new Error('missing task')
  if (!toAgentId) throw new Error('missing target agent')
  if (!message) throw new Error('missing message')

  const existing = task.message || task.description || ''
  const header = `### Delegated to ${toAgentId}`
  const details = [
    fromAgentId ? `From: ${fromAgentId}` : null,
    `At: ${delegatedAt}`,
  ].filter(Boolean).join('\n')
  const addition = `${header}\n\n${details}\n\n${message}`
  return existing ? `${existing}\n\n---\n\n${addition}` : addition
}

export async function transferTaskLifecycle({
  fleetStore,
  task,
  fromAgentId = null,
  toAgentId,
  message,
  description,
  delegatedAt = new Date().toISOString(),
  eventMetadata,
  eventOptions,
  taskMetadataPatch,
}) {
  if (!fleetStore) throw new Error('missing fleetStore')
  if (!task?.id) throw new Error('missing task')
  if (!toAgentId) throw new Error('missing target agent')
  if (!message) throw new Error('missing message')
  if (task.status === 'done' || task.status === 'retracted') throw new Error('cannot delegate a closed task')

  const transferredTask = {
    ...task,
    agent: toAgentId,
    // A re-delegation may restate the task, not only append to it. Omitting
    // `description` keeps the existing one, which is what a plain hand-off wants.
    description: description ?? task.description,
    message: appendDelegationMessage(task, { fromAgentId, toAgentId, message, delegatedAt }),
  }
  if (taskMetadataPatch) {
    const nextMetadata = { ...(task.metadata || {}) }
    for (const [key, value] of Object.entries(taskMetadataPatch)) {
      if (value === undefined) delete nextMetadata[key]
      else nextMetadata[key] = value
    }
    transferredTask.metadata = Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined
  }

  await fleetStore.upsertTask(transferredTask)
  const event = await fleetStore.delegate?.(fromAgentId, toAgentId, task.id, task.description, eventMetadata, eventOptions)
  return {
    task: transferredTask,
    event: event || null,
    eventId: event?.id || null,
  }
}

export function appendTaskMessage(task, {
  fromAgentId,
  message,
  appendedAt = new Date().toISOString(),
}) {
  if (!task?.id) throw new Error('missing task')
  if (!fromAgentId) throw new Error('missing appending agent')
  if (!message) throw new Error('missing message')

  const existing = task.message || task.description || ''
  const addition = `### Appended by ${fromAgentId}\n\nAt: ${appendedAt}\n\n${message}`
  return existing ? `${existing}\n\n---\n\n${addition}` : addition
}

// Append authority is deliberately narrower than canReportTask: the owner, the
// recording delegator, or a human — no management-chain grant. (Product
// decision, PM-approved: a follow-up lands in the task the owner is executing,
// so the writers are the two parties to the delegation.)
export function canAppendTask({ caller, task }) {
  if (!caller?.id || !task?.id) return false
  if (caller.human) return true
  return task.agent === caller.id || task.delegated_by === caller.id
}

function ownerPendingForAppend(ownerRow) {
  if (!ownerRow || ownerRow.dead) return false
  const shell = ownerRow.metadata?.shell
  return shell === true || shell === 1
}

export async function appendTaskLifecycle({
  fleetStore,
  task,
  caller,
  message,
  appendedAt = new Date().toISOString(),
  ownerRow = null,
  onNudge = null,
}) {
  if (!fleetStore) throw new Error('missing fleetStore')
  if (!task?.id) throw new Error('missing task')
  if (!message) throw new Error('missing message')
  if (task.status === 'done' || task.status === 'retracted') throw new Error('cannot append to a closed task')
  if (!canAppendTask({ caller, task })) {
    throw new Error(`task-append refused: ${caller?.id || 'unknown caller'} is neither the owner nor the delegator of [${task.id}] (owner ${task.agent}, delegator ${task.delegated_by})`)
  }
  const appendedTask = {
    ...task,
    message: appendTaskMessage(task, { fromAgentId: caller.id, message, appendedAt }),
  }
  await fleetStore.upsertTask(appendedTask)
  // Nudge on append-after-arrival only: a pending owner reads the follow-up at
  // pickup, and there is no session to wake before then. The nudge outcome is
  // reported, not assumed — a wake path that declines (human owner, dead
  // daemon) must read as not-nudged, never as nudged.
  if (!ownerRow) return { task: appendedTask, nudged: false, nudgeSkipped: 'missing-owner' }
  if (ownerRow.dead) return { task: appendedTask, nudged: false, nudgeSkipped: 'dead-owner' }
  if (ownerPendingForAppend(ownerRow)) return { task: appendedTask, nudged: false, nudgeSkipped: 'pending' }
  if (!onNudge) return { task: appendedTask, nudged: false, nudgeSkipped: 'nudge-unavailable' }
  const nudgeResult = await onNudge(task.agent, `Task [${task.id}] has a follow-up from ${caller.id} — re-read the task.`)
  if (nudgeResult && nudgeResult.nudged === false) {
    return { task: appendedTask, nudged: false, nudgeSkipped: nudgeResult.reason || 'nudge-failed' }
  }
  return { task: appendedTask, nudged: true, nudgeSkipped: null }
}

// Coordination guard, not a security boundary. Active temporary delegation
// markers intentionally grant manager cleanup authority. Do not replace this
// with immutable or pre-existing delegation-lineage semantics.
//
// The fence is deliberately low and deliberately easy to pass — see "The
// authorization gate is a fence, not a wall" in AGENTS.md. Tightening it is a
// product change, not a cleanup.
export async function canReportTask({ caller, task, fleetStore }) {
  if (!caller?.id || !task?.id) return false
  if (caller.human || task.agent === caller.id || task.delegated_by === caller.id) return true
  if (!fleetStore) return false

  const managedAgents = new Set([caller.id])
  const pendingManagers = [caller.id]
  const activeTasks = await fleetStore.getActiveTasks()
  while (pendingManagers.length > 0) {
    const manager = pendingManagers.shift()
    for (const delegatedTask of activeTasks) {
      if (delegatedTask.delegated_by !== manager || !delegatedTask.agent || managedAgents.has(delegatedTask.agent)) continue
      managedAgents.add(delegatedTask.agent)
      pendingManagers.push(delegatedTask.agent)
    }
  }

  return managedAgents.has(task.agent) || managedAgents.has(task.delegated_by)
}
