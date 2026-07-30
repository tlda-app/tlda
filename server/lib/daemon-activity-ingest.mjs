import { boundActivityMetadata, boundActivityPayload } from '../../shared/activity-payload-bounds.mjs'

export function finiteMessageMs(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function normalizeDaemonActivityEvent(msg, { serverReceivedAtMs = Date.now(), serverBroadcastQueuedAtMs = Date.now() } = {}) {
  const {
    tool,
    arg,
    input,
    ts,
    usage,
    prettyResult,
    origTool,
    status,
    duration,
    correlationId,
    daemon_received_at,
    daemon_received_at_ms,
    daemon_sent_at,
    daemon_sent_at_ms,
  } = msg || {}

  const activityLatency = {
    jsonlTs: ts || null,
    daemonReceivedAt: daemon_received_at || null,
    daemonReceivedAtMs: finiteMessageMs(daemon_received_at_ms),
    daemonSentAt: daemon_sent_at || null,
    daemonSentAtMs: finiteMessageMs(daemon_sent_at_ms),
    serverReceivedAt: new Date(serverReceivedAtMs).toISOString(),
    serverReceivedAtMs,
    serverBroadcastQueuedAt: new Date(serverBroadcastQueuedAtMs).toISOString(),
    serverBroadcastQueuedAtMs,
  }

  return {
    text: tool === '_text' ? boundActivityPayload(arg || '') : (tool || ''),
    metadata: boundActivityMetadata({ tool, arg, input, usage, prettyResult, origTool, status, duration, correlationId, activityLatency }),
    timestamp: ts || new Date().toISOString(),
    activityLatency,
  }
}

export function buildDaemonActivityRecord(msg, timing = {}) {
  const { agent_id } = msg || {}
  const activity = normalizeDaemonActivityEvent(msg, timing)
  return {
    type: 'activity',
    from: agent_id,
    to: agent_id,
    text: activity.text,
    metadata: activity.metadata,
    unread: false,
    timestamp: activity.timestamp,
  }
}
