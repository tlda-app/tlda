const activeEdits = new Map()

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
  if (message.status === 'completed' || message.status === 'error') {
    activeEdits.delete(key)
  } else {
    activeEdits.set(key, { project, file, agentId: message.agent_id })
  }
  return true
}

export function activeSourceEditors(project, file) {
  const editors = new Set()
  for (const edit of activeEdits.values()) {
    if (edit.project === project && edit.file === file) editors.add(edit.agentId)
  }
  return [...editors]
}

export function clearSourceEditsForAgent(agentId) {
  for (const [key, edit] of activeEdits) {
    if (edit.agentId === agentId) activeEdits.delete(key)
  }
}
