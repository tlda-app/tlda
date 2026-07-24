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

export function canReportTask({ caller, task, fleetStore }) {
  if (!caller?.id || !task?.id) return false
  if (caller.human || task.agent === caller.id || task.delegated_by === caller.id) return true
  if (!fleetStore?.getActiveTasks) return false

  const managedAgents = new Set([caller.id])
  const pendingManagers = [caller.id]
  const activeTasks = fleetStore.getActiveTasks()
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
