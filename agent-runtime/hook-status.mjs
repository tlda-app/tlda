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
// PreCompact, PostToolUse, PostToolUseFailure) is either a session/subagent
// binding concern owned elsewhere, an observational detail below the
// thinking/idle grain, or a live-verification gap — see the row comments in
// .scratch/status-audit-table.md. Unknown names return null: hook silence
// must never fabricate an edge.
const ACTIVITY_BY_HOOK_EVENT = Object.freeze({
  // A tool is about to run: the agent is working. Carried tool comes from
  // the payload (tool_name), not from this table.
  PreToolUse: 'thinking',
  // The turn produced no further work: idle, subject to the daemon's
  // idle-confirm hysteresis (a single Stop never fabricates a turn end).
  Stop: 'idle',
  // The turn ended because the tool call failed or permission was denied:
  // nothing is running underneath any more.
  StopFailure: 'idle',
  PermissionDenied: 'idle',
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
