const DEFAULT_RECENT_LIMIT = 80

export const ACTIVITY_DELIVERY_STAGES = Object.freeze({
  JSONL_EXTRACTED: 'jsonlExtracted',
  DAEMON_QUEUED: 'daemonQueued',
  DAEMON_SENT: 'daemonSent',
  DAEMON_ACKED: 'daemonAcked',
  DAEMON_DROPPED: 'daemonDropped',
  DAEMON_WS_CONNECTED: 'daemonWsConnected',
  DAEMON_WS_DISCONNECTED: 'daemonWsDisconnected',
  JSONL_INGESTER_DOWN: 'jsonlIngesterDown',
  SERVER_ACCEPTED: 'serverAccepted',
  SERVER_BROADCAST: 'serverBroadcast',
  BROWSER_CONVERTED: 'browserConverted',
  BROWSER_RENDERED: 'browserRendered',
  BROWSER_ERRORS: 'browserErrors',
})

function nowIso() {
  return new Date().toISOString()
}

function messageKind(input) {
  return input?.type || input?.event_type || input?.event || 'unknown'
}

function cloneByStage(byStage) {
  const out = {}
  for (const [stage, value] of Object.entries(byStage)) {
    out[stage] = {
      total: value.total || 0,
      byType: { ...(value.byType || {}) },
    }
  }
  return out
}

export function createActivityDeliveryCounters({
  origin,
  recentLimit = DEFAULT_RECENT_LIMIT,
  clock = nowIso,
  onChange = null,
} = {}) {
  const byStage = {}
  const recent = []
  let total = 0
  let lastUpdatedAt = null

  function record(stage, input = {}, count = 1, detail = {}) {
    const n = Number(count)
    if (!Number.isFinite(n) || n <= 0) return
    const amount = Math.trunc(n)
    const type = String(detail.type || messageKind(input))
    const bucket = byStage[stage] || (byStage[stage] = { total: 0, byType: {} })
    bucket.total += amount
    bucket.byType[type] = (bucket.byType[type] || 0) + amount
    total += amount
    lastUpdatedAt = clock()
    recent.push({
      ts: lastUpdatedAt,
      origin: origin || null,
      stage,
      type,
      count: amount,
      ...(detail.agent ? { agent: detail.agent } : {}),
      ...(detail.tool ? { tool: detail.tool } : {}),
      ...(detail.error ? { error: String(detail.error).slice(0, 500) } : {}),
    })
    while (recent.length > recentLimit) recent.shift()
    onChange?.({ stage, type, count: amount })
  }

  function snapshot() {
    return {
      origin: origin || null,
      total,
      lastUpdatedAt,
      byStage: cloneByStage(byStage),
      recent: recent.slice(),
    }
  }

  return {
    record,
    snapshot,
  }
}
