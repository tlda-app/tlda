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
