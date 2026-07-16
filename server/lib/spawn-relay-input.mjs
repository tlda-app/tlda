export function normalizeSpawnRelayInput(msg = {}) {
  if (Object.prototype.hasOwnProperty.call(msg, 'policy')) {
    throw new Error('spawn relay rejected legacy "policy"; use permissionRequest')
  }
  const {
    name, agent, model, doc, cwd, respawn, fresh, refresh, effort, mode,
    permissionRequest, session, sessionId, session_id, enroll, routeAgent,
    iLikeToLiveDangerously, phase, mailboxTarget,
  } = msg || {}
  const requestedSession = session || sessionId || session_id || null
  const spawnReservedKeys = new Set([
    'type', 'name', 'agent', 'model', 'doc', 'cwd', 'respawn', 'fresh', 'refresh',
    'effort', 'mode', 'permissionRequest', 'session', 'sessionId', 'session_id',
    'enroll', 'routeAgent', 'iLikeToLiveDangerously', 'phase', 'mailboxTarget',
    'modelOptions',
  ])
  const modelOptions = {
    ...(msg?.modelOptions && typeof msg.modelOptions === 'object' && !Array.isArray(msg.modelOptions) ? msg.modelOptions : {}),
    ...(effort ? { effort } : {}),
  }
  for (const [key, value] of Object.entries(msg || {})) {
    if (!spawnReservedKeys.has(key) && value != null && value !== '') modelOptions[key] = value
  }
  return {
    name,
    agent,
    model,
    doc,
    cwd,
    respawn,
    fresh,
    refresh,
    effort,
    mode,
    permissionRequest,
    session,
    sessionId,
    session_id,
    enroll,
    routeAgent,
    iLikeToLiveDangerously,
    phase,
    mailboxTarget,
    requestedSession,
    modelOptions,
  }
}
