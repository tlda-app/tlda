// Daemon-side receivers for evidence forwarded from elsewhere. The hook
// script and the server observe things the daemon cannot see directly; they
// send the raw facts here, and this module maps them to envelopes for
// admitEvidence(). Mapping failures decline (return admitted:false) rather
// than guessing; malformed values pass through for admission to drop with
// a warning, so the drop tripwire sees them.

export function hookBodyToEvidence(body = {}, atMs = Date.now()) {
  const agentId = typeof body?.agent_id === 'string' ? body.agent_id : null
  if (!agentId) return null
  const envelope = { agentId, source: 'hook', atMs }
  if (typeof body.activity === 'string') envelope.activity = body.activity
  if (body.activity !== 'unknown') envelope.process = 'alive'
  if (typeof body.tool === 'string' && body.tool.trim()) envelope.tool = body.tool.trim()
  return envelope
}

export function serverActivityToEvidence(params = {}, atMs = Date.now()) {
  const agentId = typeof params?.agent_id === 'string' ? params.agent_id : null
  if (!agentId) return null
  const observedAt = Number.isFinite(params?.atMs) ? params.atMs : atMs
  return { agentId, source: 'server-observed', atMs: observedAt, activity: 'active' }
}

export function createRemoteEvidence({ isBound, admit, log, now = () => Date.now() } = {}) {
  function receive(map, params, what) {
    const envelope = map(params, now())
    if (!envelope) return { ok: true, admitted: false, reason: 'unmappable' }
    if (typeof isBound === 'function' && !isBound(envelope.agentId)) {
      return { ok: true, admitted: false, reason: 'unbound' }
    }
    const out = admit(envelope)
    if (out === undefined) return { ok: true, admitted: false, reason: 'dropped' }
    return { ok: true, admitted: true }
  }

  return {
    admitHook: (params = {}) => receive(hookBodyToEvidence, params, 'hook'),
    admitServerActivity: (params = {}) => receive(serverActivityToEvidence, params, 'server-activity'),
  }
}
