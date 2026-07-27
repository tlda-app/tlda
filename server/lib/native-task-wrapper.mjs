function nativeSystemLabel(nativeSystem) {
  return nativeSystem === 'claude' ? 'Claude Code' : nativeSystem
}

export function nativeTaskIdForEvent({ nativeSystem, agentId, sessionId, nativeTaskId }) {
  return `native:${nativeSystem}:${agentId}:${sessionId || 'session'}:${nativeTaskId}`
}

export function applyNativeTaskEvents(fleetStore, msg) {
  if (!fleetStore) return { changed: false, tasks: [] }
  const { agent_id, harness, session_id, source_path, events } = msg || {}
  if (!agent_id || !Array.isArray(events)) return { changed: false, tasks: [] }
  const agent = fleetStore.getAgent?.(agent_id)
  if (!agent) return { changed: false, tasks: [] }

  const tasks = []
  for (const event of events) {
    const nativeTaskId = event?.nativeTaskId
    if (!nativeTaskId) continue
    const nativeSystem = event.nativeSystem || harness || 'unknown'
    const taskId = nativeTaskIdForEvent({ nativeSystem, agentId: agent_id, sessionId: session_id, nativeTaskId })
    const existing = fleetStore.getTask?.(taskId)
    const now = event.timestamp || new Date().toISOString()
    const title = event.subject || event.activeForm || existing?.description || `Native task ${nativeTaskId}`
    const description = event.description || existing?.metadata?.native_payload?.description || ''
    const status = event.status || existing?.status || 'pending'
    const metadata = {
      ...(existing?.metadata || {}),
      native: true,
      native_system: nativeSystem,
      native_task_id: String(nativeTaskId),
      native_source: event.action || existing?.metadata?.native_source || 'unknown',
      native_status: event.status || existing?.metadata?.native_status || null,
      source_session_id: session_id || null,
      source_path: source_path || null,
      native_payload: {
        ...(existing?.metadata?.native_payload || {}),
        ...(event.subject ? { subject: event.subject } : {}),
        ...(event.description ? { description: event.description } : {}),
        ...(event.activeForm ? { activeForm: event.activeForm } : {}),
        ...(event.owner ? { owner: event.owner } : {}),
        ...(event.metadataPatch ? { metadata: event.metadataPatch } : {}),
        input: event.input || existing?.metadata?.native_payload?.input || null,
      },
      last_native_event_at: now,
    }
    const subject = event.subject || metadata.native_payload.subject
    const activeForm = event.activeForm || metadata.native_payload.activeForm
    const lines = [
      `Native task in ${nativeSystemLabel(nativeSystem)}`,
      '',
      subject ? `Subject: ${subject}` : '',
      activeForm ? `Active form: ${activeForm}` : '',
      description ? `Description: ${description}` : '',
    ].filter(Boolean)
    const task = {
      id: taskId,
      agent: agent_id,
      description: title,
      message: lines.join('\n'),
      delegated_by: existing?.delegated_by || null,
      delegated_at: existing?.delegated_at || now,
      status,
      acknowledged: existing?.acknowledged || false,
      completed_at: status === 'done' ? (existing?.completed_at || now) : null,
      blockedBy: existing?.blockedBy,
      success_criteria: existing?.success_criteria,
      reported: existing?.reported,
      metadata,
    }
    fleetStore.upsertTask(task)
    tasks.push(task)
  }
  return { changed: tasks.length > 0, tasks }
}
