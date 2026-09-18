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
      message: String(task.message || task.description || ''),
      criteria: Array.isArray(task.success_criteria) ? task.success_criteria.map(String) : [],
    }))
}

export function inboxTaskTransfer(task, agent, myId, myName) {
  return {
    from: myId,
    agent,
    task_id: task.id,
    message: `Assigned from the inbox by ${myName || myId}.`,
  }
}

// One button turns a sticky row into a task row. No task_id means create, and
// the task is assigned to whoever pressed it, so it appears in that person's
// own inbox in the row group directly above the notes.
export function inboxNoteTask(note, myId) {
  const preview = String(note?.preview || '').trim()
  const title = preview || '(empty note)'
  const where = [
    note?.file ? String(note.file) : null,
    note?.line != null ? `line ${note.line}` : null,
  ].filter(Boolean).join(' · ')
  return {
    from: myId,
    agent: myId,
    description: title.length > 60 ? `${title.slice(0, 59)}…` : title,
    message: where ? `${title}\n\nFrom a sticky note — ${where}.` : `${title}\n\nFrom a sticky note.`,
  }
}
