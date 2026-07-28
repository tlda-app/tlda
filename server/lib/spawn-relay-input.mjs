export function normalizeSpawnRelayInput(msg = {}) {
  if (Object.prototype.hasOwnProperty.call(msg, 'policy')) {
    throw new Error('spawn relay rejected legacy "policy"; use permissionRequest')
  }
  if (
    Object.prototype.hasOwnProperty.call(msg, 'session') ||
    Object.prototype.hasOwnProperty.call(msg, 'sessionId') ||
    Object.prototype.hasOwnProperty.call(msg, 'session_id')
  ) {
    throw new Error('spawn session selection belongs to the daemon')
  }
  const {
    name, agent, model, doc, cwd, respawn, fresh, refresh, effort, mode,
    permissionRequest, enroll, routeAgent,
    iLikeToLiveDangerously, mailboxTarget, pretty_name,
  } = msg || {}
  const spawnReservedKeys = new Set([
    'type', 'name', 'agent', 'model', 'doc', 'cwd', 'respawn', 'fresh', 'refresh',
    'effort', 'mode', 'permissionRequest',
    'enroll', 'routeAgent', 'iLikeToLiveDangerously', 'mailboxTarget',
    'pretty_name',
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
    enroll,
    routeAgent,
    iLikeToLiveDangerously,
    mailboxTarget,
    pretty_name,
    modelOptions,
  }
}
