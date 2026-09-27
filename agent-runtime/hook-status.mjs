// Claude hook → agent-status triggers.
//
// Hooks are ADDITIONAL triggers into the same thinking/compacting/idle/unknown
// activity vocabulary the pane classifier emits (agent-runtime/status-
// classifier.mjs → daemon/agent-status.mjs → server `agent-status` message →
// canonical server/lib/agent-runtime-status.mjs). Nothing here replaces the
// classifier: hooks are authoritative where they fire and silent where they
// don't, and the pane scrape keeps covering the gaps (running/idle in
// interactive sessions, user-input-wait, PermissionRequest until live-verified).
//
// This module is PURE (hook payload in, transition out) so it is table-
// testable beside decideThinkingEdge/shouldDisarm. The daemon owns delivery:
// the hook script POSTs to the server's /api/fleet/hook-status route, which
// applies the same agent-status path unified-server.mjs already handles — so
// hook evidence and pane evidence converge in runtimeStatusStore.updateActivity,
// latest-wins by atMs.

// Claude hook events that produce an agent-status activity edge. Everything
// else the binary confirms (SessionStart/End, UserPromptSubmit, SubagentStart/
// SubagentStop, PostToolBatch, TaskCompleted, TeammateIdle, Notification,
// PreCompact, PostToolUse, PostToolUseFailure, PermissionDenied,
// PermissionRequest) is either a session/subagent binding concern owned
// elsewhere, an observational detail below the thinking/idle grain, a state
// the pane owns (permission: continuously observable in the pane, only
// transition-visible to a hook — a hook edge there would flap against the
// pane under latest-wins), or a live-verification gap — see the row comments
// in .scratch/status-audit-table.md. Unknown names return null: hook silence
// must never fabricate an edge.
const ACTIVITY_BY_HOOK_EVENT = Object.freeze({
  // A tool is about to run: the agent is working. Carried tool comes from
  // the payload (tool_name), not from this table.
  PreToolUse: 'thinking',
  // The turn produced no further work: idle. A hook Stop is a turn-end event,
  // not a sampled glance, so it needs none of the pane path's idle-confirm
  // hysteresis — and a turn that continues self-heals on the next PreToolUse.
  Stop: 'idle',
  // The turn ended because the tool call failed: nothing is running
  // underneath any more.
  StopFailure: 'idle',
})

export function hookActivityFor(hookEventName) {
  if (typeof hookEventName !== 'string') return null
  return ACTIVITY_BY_HOOK_EVENT[hookEventName] || null
}

// Map one Claude hook envelope to an agent-status transition, or null when
// the event carries no activity edge. Returns { activity, tool } — the tool
// is the hook's own tool_name, which the server attaches exactly the way the
// daemon attaches latestTool on the pane path.
export function hookStatusTransition(event) {
  const name = event?.hook_event_name
  const activity = hookActivityFor(name)
  if (!activity) return null
  const rawTool = event?.tool_name
  const tool = typeof rawTool === 'string' && rawTool.trim() ? rawTool.trim() : null
  return { activity, tool }
}
