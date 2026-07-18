function parseMetadata(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

const MAX_ACTIVITY_DETAIL_CHARS = 500

export function projectAgentActivityPage(page) {
  return {
    agents: (page?.agents || []).map(agent => ({
      friendly_name: agent.friendly_name || agent.id,
      status: agent.runtime_status?.status,
      activity: agent.runtime_status?.activity,
      activity_tool: agent.runtime_status?.evidence?.activity_tool,
      updated_at: agent.runtime_status?.updated_at,
      route_state: agent.runtime_status?.route_state,
    })),
    totals: [{
      awake: page?.totals?.awake || 0,
      hibernating: page?.totals?.hibernating || 0,
      total: page?.totals?.total || 0,
    }],
    pagination: [{ next_cursor: page?.nextCursor || 'all current agents shown' }],
  }
}

export function projectActivityEventsPage(page) {
  return {
    events: (page?.events || []).map(event => ({
      id: event.id,
      timestamp: event.timestamp,
      from: event.from,
      tool: parseMetadata(event.metadata).tool || '',
      text: String(event.text || '').slice(0, MAX_ACTIVITY_DETAIL_CHARS),
    })),
    lastId: page?.lastId ?? null,
  }
}
