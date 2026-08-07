const activeEdits = new Map()
const SOURCE_EDIT_TIMEOUT_MS = 5 * 60 * 1000

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
  if (message.status === 'error') {
    activeEdits.delete(key)
  } else if (message.status !== 'completed') {
    activeEdits.set(key, { project, file, agentId: message.agent_id, startedAt: Date.now(), toolCompleted: false })
  } else if (activeEdits.has(key)) {
    activeEdits.get(key).toolCompleted = true
  }
  return true
}

export function activeSourceEditors(project, file) {
  const now = Date.now()
  const editors = new Set()
  for (const [key, edit] of activeEdits) {
    if (now - edit.startedAt > SOURCE_EDIT_TIMEOUT_MS) {
      activeEdits.delete(key)
      continue
    }
    if (edit.project === project && edit.file === file) editors.add(edit.agentId)
  }
  return [...editors]
}

export function clearSourceEditsForAgent(agentId) {
  for (const [key, edit] of activeEdits) {
    if (edit.agentId === agentId) activeEdits.delete(key)
  }
}

export function recordSourceEditTurnEnded(agentId) {
  clearSourceEditsForAgent(agentId)
}

export const __test = { reset: () => activeEdits.clear() }
