export async function completeTaskLifecycle({
  fleetStore,
  agentId,
  task,
  description = task?.description,
  completedAt = new Date().toISOString(),
  eventMetadata,
  taskMetadataPatch,
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

  fleetStore.upsertTask(completedTask)
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
  delegatedAt = new Date().toISOString(),
  eventMetadata,
}) {
  if (!fleetStore) throw new Error('missing fleetStore')
  if (!task?.id) throw new Error('missing task')
  if (!toAgentId) throw new Error('missing target agent')
  if (!message) throw new Error('missing message')
  if (task.status === 'done' || task.status === 'retracted') throw new Error('cannot delegate a closed task')

  const transferredTask = {
    ...task,
    agent: toAgentId,
    message: appendDelegationMessage(task, { fromAgentId, toAgentId, message, delegatedAt }),
  }

  fleetStore.upsertTask(transferredTask)
  const event = await fleetStore.delegate?.(fromAgentId, toAgentId, task.id, task.description, eventMetadata)
  return {
    task: transferredTask,
    event: event || null,
    eventId: event?.id || null,
  }
}

// Coordination guard, not a security boundary. Active temporary delegation
// markers intentionally grant manager cleanup authority. Do not replace this
// with immutable or pre-existing delegation-lineage semantics.
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
