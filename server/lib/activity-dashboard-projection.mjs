export function projectAgentActivityPage(page) {
  return {
    agents: (page?.agents || []).map(agent => ({
      friendly_name: agent.friendly_name || agent.id,
      status: agent.runtime_status?.status,
      activity: agent.runtime_status?.activity,
      activity_tool: agent.runtime_status?.evidence?.activity_tool,
      updated_at: agent.runtime_status?.updated_at,
    })),
    totals: [{
      awake: page?.totals?.awake || 0,
      hibernating: page?.totals?.hibernating || 0,
      total: page?.totals?.total || 0,
    }],
    pagination: [{ next_cursor: page?.nextCursor || 'all current agents shown' }],
  }
}
