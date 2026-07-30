export function projectOwnedFleetTasks(tasks, myId) {
  if (!myId) return []
  return tasks
    .filter(task => task.agent === myId && task.status !== 'done' && task.status !== 'retracted')
    .map(task => ({
      id: String(task.id),
      description: String(task.description || task.title || task.message || task.id),
      status: String(task.status || 'pending'),
      delegatedAt: String(task.delegated_at || ''),
      delegatedBy: String(task.delegated_by || ''),
      criteria: Array.isArray(task.success_criteria) ? task.success_criteria.map(String) : [],
    }))
}

export function fleetTaskDropTarget(elements, pillType) {
  if (pillType !== 'agent') return null
  for (const element of elements) {
    const row = element.closest?.('[data-fleet-task-id]')
    if (row?.dataset?.fleetTaskId) return row
  }
  return null
}

export function inboxTaskTransfer(task, agent, myId, myName) {
  return {
    from: myId,
    agent,
    task_id: task.id,
    message: `Assigned from the inbox by ${myName || myId}.`,
  }
}
