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

// The marker that makes the conversion stick. The note row leaves the notes
// group when a task claims it, and after a reload the only thing that can say
// which note a task came from is the task itself — so the id rides in the
// message rather than in a new field the task wire does not have.
const NOTE_REF = 'sticky-note:'

export function noteTaskRef(noteId) {
  return `${NOTE_REF}${noteId}`
}

/** Ids of notes already turned into one of `tasks`. */
export function notesClaimedByTasks(tasks) {
  const claimed = new Set()
  for (const task of tasks || []) {
    const text = String(task?.message || '')
    let from = text.indexOf(NOTE_REF)
    while (from !== -1) {
      const id = text.slice(from + NOTE_REF.length).split(/[\s)\].,]/)[0]
      if (id) claimed.add(id)
      from = text.indexOf(NOTE_REF, from + NOTE_REF.length)
    }
  }
  return claimed
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
    message: [
      title,
      '',
      where ? `From a sticky note — ${where}.` : 'From a sticky note.',
      noteTaskRef(note?.id),
    ].join('\n'),
  }
}
