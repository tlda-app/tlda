const OUTCOMES_REQUIRING_INCIDENT = new Set(['no-route', 'send-failed'])

function compactObject(obj) {
  const out = {}
  for (const [key, value] of Object.entries(obj || {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function normalizeAttempt(raw = {}) {
  const attemptedAt = raw.attemptedAt || new Date().toISOString()
  return compactObject({
    agentId: raw.agentId,
    reason: raw.reason || 'manual',
    sourceEventId: raw.sourceEventId ?? null,
    sourceTaskId: raw.sourceTaskId ?? null,
    traceId: raw.traceId || raw.trace_id || null,
    priority: raw.priority || 'normal',
    intendedSurface: raw.intendedSurface || 'channel',
    policy: raw.policy || 'immediate',
    attemptedAt,
    outcome: raw.outcome || 'skipped',
    evidence: raw.evidence || {},
    nextAction: raw.nextAction || 'none',
    nextAttemptAt: raw.nextAttemptAt ?? null,
  })
}

export function createNotificationAttemptRecorder({ fleetStore, logger, reportIncident }) {
  return {
    async record(raw) {
      const attempt = normalizeAttempt(raw)
      if (!attempt.agentId) throw new Error('notification attempt requires agentId')
      if (!attempt.outcome) throw new Error('notification attempt requires outcome')

      logger?.info?.({
        event: 'notification_attempt',
        ...attempt,
      }, 'notification attempt recorded')

      const event = await fleetStore?.share?.({
        type: 'notification_attempt',
        from: 'fleet:tlda',
        to: attempt.agentId,
        text: `notification ${attempt.outcome} for ${attempt.agentId}`,
        metadata: { ...attempt, ...(attempt.traceId ? { trace_id: attempt.traceId } : {}) },
        unread: false,
      })

      if (OUTCOMES_REQUIRING_INCIDENT.has(attempt.outcome)) {
        await reportIncident?.({
          severity: 'warning',
          component: 'notification-delivery',
          operation: 'notify-inbox-pending',
          actors: { agentId: attempt.agentId },
          impact: `Agent ${attempt.agentId} has pending inbox state but notification outcome was ${attempt.outcome}.`,
          evidence: {
            notificationAttemptEventId: event?.id || null,
            sourceEventId: attempt.sourceEventId,
            intendedSurface: attempt.intendedSurface,
            nextAction: attempt.nextAction,
          },
          error: attempt.evidence?.error || null,
        })
      }

      return { ok: true, attempt, eventId: event?.id || null }
    },
  }
}
