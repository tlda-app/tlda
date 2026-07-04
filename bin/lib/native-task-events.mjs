const CLAUDE_STATUS_MAP = new Map([
  ['pending', 'pending'],
  ['in_progress', 'working'],
  ['working', 'working'],
  ['blocked', 'blocked'],
  ['completed', 'done'],
  ['complete', 'done'],
  ['done', 'done'],
])

function contentBlocks(record) {
  const content = record?.message?.content
  if (!content) return []
  return Array.isArray(content) ? content : [content]
}

function shortText(value, max = 240) {
  const text = String(value || '').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function claudeStatus(status) {
  if (!status) return null
  return CLAUDE_STATUS_MAP.get(String(status)) || String(status)
}

function taskCreateFromResult(record, state) {
  if (record?.type !== 'user') return []
  const result = record.toolUseResult
  const nativeTaskId = result?.task?.id || result?.taskId
  if (!nativeTaskId) return []
  const out = []
  for (const block of contentBlocks(record)) {
    if (block?.type !== 'tool_result' || !block.tool_use_id) continue
    const pending = state.pendingClaudeTaskCreates.get(block.tool_use_id)
    if (!pending) continue
    state.pendingClaudeTaskCreates.delete(block.tool_use_id)
    out.push({
      action: 'create',
      nativeSystem: 'claude',
      nativeTaskId: String(nativeTaskId),
      toolUseId: block.tool_use_id,
      timestamp: record.timestamp || pending.timestamp || null,
      subject: shortText(pending.input?.subject, 500),
      description: String(pending.input?.description || '').trim(),
      activeForm: shortText(pending.input?.activeForm, 500),
      status: 'pending',
      input: pending.input || {},
    })
  }
  return out
}

function taskUpdatesFromAssistant(record) {
  if (record?.type !== 'assistant') return []
  const out = []
  for (const block of contentBlocks(record)) {
    if (block?.type !== 'tool_use') continue
    const input = block.input || {}
    if (block.name === 'TaskCreate') {
      // The stable native id is returned in the following tool_result. The
      // caller stores this input until that result arrives.
      continue
    }
    if (block.name !== 'TaskUpdate') continue
    const nativeTaskId = input.taskId ?? input.id
    if (nativeTaskId == null) continue
    out.push({
      action: 'update',
      nativeSystem: 'claude',
      nativeTaskId: String(nativeTaskId),
      toolUseId: block.id || null,
      timestamp: record.timestamp || null,
      status: claudeStatus(input.status),
      subject: shortText(input.subject, 500),
      description: input.description != null ? String(input.description).trim() : '',
      activeForm: shortText(input.activeForm, 500),
      owner: input.owner || null,
      metadataPatch: input.metadata || null,
      input,
    })
  }
  return out
}

export function createNativeTaskState() {
  return { pendingClaudeTaskCreates: new Map() }
}

export function extractNativeTaskEvents({ harnessKind, record, state }) {
  if (harnessKind !== 'claude' || !record || typeof record !== 'object') return []
  if (!state?.pendingClaudeTaskCreates) throw new Error('native task state missing pendingClaudeTaskCreates')

  const out = []
  if (record.type === 'assistant') {
    for (const block of contentBlocks(record)) {
      if (block?.type === 'tool_use' && block.name === 'TaskCreate') {
        state.pendingClaudeTaskCreates.set(block.id, {
          input: block.input || {},
          timestamp: record.timestamp || null,
        })
      }
    }
    out.push(...taskUpdatesFromAssistant(record))
  }
  out.push(...taskCreateFromResult(record, state))
  return out
}
