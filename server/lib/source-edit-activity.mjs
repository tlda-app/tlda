const activeEdits = new Map()
const SOURCE_EDIT_TIMEOUT_MS = 5 * 60 * 1000

// Who wants to be told when the editor set for a (project, file) changes.
// The set used to be discovered by polling: BuildProgressPill asked
// /source-activity once a second per open file, so every change was found
// within a second and expiry was found whenever somebody next asked. Nothing
// here knows about sockets -- the server subscribes and broadcasts.
const listeners = new Set()
const expiryTimers = new Map()

function announce(project, file) {
  if (!project || !file) return
  for (const listener of listeners) {
    try { listener({ project, file }) }
    catch (e) { console.error(`[source-edit-activity] listener failed: ${e.message}`) }
  }
}

// Expiry is the one change with no caller behind it. Under polling it needed no
// timer, because the next reader swept it; a subscriber is told nothing by a
// sweep that never runs. One unref'd timer per active edit, re-checked on fire
// because the edit may have ended on its own first.
function armExpiry(key) {
  clearTimeout(expiryTimers.get(key))
  const timer = setTimeout(() => {
    expiryTimers.delete(key)
    const edit = activeEdits.get(key)
    if (!edit || Date.now() - edit.startedAt <= SOURCE_EDIT_TIMEOUT_MS) return
    activeEdits.delete(key)
    announce(edit.project, edit.file)
  }, SOURCE_EDIT_TIMEOUT_MS + 1000)
  timer.unref?.()
  expiryTimers.set(key, timer)
}

function forget(key) {
  clearTimeout(expiryTimers.get(key))
  expiryTimers.delete(key)
  activeEdits.delete(key)
}

/** Subscribe to editor-set changes. Returns an unsubscribe function. */
export function onSourceEditActivityChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function isEdit(message) {
  if (!['Edit', 'Write', 'MultiEdit'].includes(message?.tool)) return null
  return true
}

export function recordSourceEditActivity(message) {
  if (!isEdit(message) || !message?.agent_id || !message?.project || !message?.sourceFile) return false
  const project = message.project
  const file = message.sourceFile
  const correlationId = message.correlationId || `${message.agent_id}:${file}`
  const key = `${message.agent_id}:${correlationId}`
  const wasActive = activeEdits.has(key)
  if (message.status === 'error') {
    forget(key)
    if (wasActive) announce(project, file)
  } else if (message.status !== 'completed') {
    activeEdits.set(key, { project, file, agentId: message.agent_id, startedAt: Date.now(), toolCompleted: false })
    armExpiry(key)
    if (!wasActive) announce(project, file)
  } else if (wasActive) {
    activeEdits.get(key).toolCompleted = true
  }
  // Only editor-set transitions announce from here, because that is all this
  // module knows. `lastChangedAt`/`lastChangedBy` come from the stored activity
  // row, which the caller writes after this returns -- announcing them here
  // would read the row one edit stale. The caller announces that edge itself.
  return true
}

export function activeSourceEditors(project, file) {
  const now = Date.now()
  const editors = new Set()
  for (const [key, edit] of activeEdits) {
    if (now - edit.startedAt > SOURCE_EDIT_TIMEOUT_MS) {
      forget(key)
      continue
    }
    if (edit.project === project && edit.file === file) editors.add(edit.agentId)
  }
  return [...editors]
}

export function clearSourceEditsForAgent(agentId) {
  const cleared = new Map()
  for (const [key, edit] of activeEdits) {
    if (edit.agentId !== agentId) continue
    forget(key)
    cleared.set(`${edit.project}::${edit.file}`, edit)
  }
  for (const edit of cleared.values()) announce(edit.project, edit.file)
}

export function recordSourceEditTurnEnded(agentId) {
  clearSourceEditsForAgent(agentId)
}

export const __test = {
  reset: () => {
    for (const timer of expiryTimers.values()) clearTimeout(timer)
    expiryTimers.clear()
    activeEdits.clear()
    listeners.clear()
  },
}
