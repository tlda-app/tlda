function eventKey(event) {
  if (event?._dbId != null) return `db:${event._dbId}`
  if (event?._tempId) return `tmp:${event._tempId}`
  return `anon:${event?.type || ''}:${event?.timestamp || ''}:${event?.from || ''}:${event?.text || ''}`
}

// Filtered chat buffers own scrollback, but the global event store owns the
// live WebSocket tail. Keep both visible while a buffer is created/re-keyed so
// a reconnect or agent-identity refresh cannot replace real messages with an
// empty buffer.
export function mergeVisibleChatEvents(bufferedEvents = [], liveEvents = []) {
  const byKey = new Map()
  for (const event of bufferedEvents) byKey.set(eventKey(event), event)
  for (const event of liveEvents) byKey.set(eventKey(event), event)
  return [...byKey.values()].sort((a, b) => {
    const aId = Number(a?._dbId)
    const bId = Number(b?._dbId)
    if (Number.isFinite(aId) && Number.isFinite(bId)) return aId - bId
    return String(a?.timestamp || '').localeCompare(String(b?.timestamp || ''))
  })
}

// Terminal routing is agent-id -> current durable seat. tmux_session is no
// longer server roster truth, so requiring it hides valid awake terminals.
export function isTerminalAvailableForAgent(agent) {
  return !!agent?.id && !agent?.dead && !agent?.hibernating && agent?.status !== 'hibernating' && agent?.status !== 'shell'
}
