export function resolveTimerParticipants({ agent, toAgent, findAgent, fallbackOwner }) {
  const from = (agent && findAgent?.(agent)?.id) || agent || fallbackOwner
  const to = (toAgent && findAgent?.(toAgent)?.id) || toAgent || from
  return { from, to }
}

export function timerDeliveryFailureResult({ state, eventId, error }) {
  const message = `timer ${state} delivery for event ${eventId} failed: ${error?.message || String(error)}`
  return { ok: false, error: message }
}

export function timerTerminalInputFailureResult({ state, eventId }) {
  if (eventId == null) return { ok: false, error: `timer ${state} requires event_id` }
  return { ok: false, error: `timer ${state} event ${eventId} not found` }
}
