const DURATION_UNITS = {
  second: 1,
  seconds: 1,
  minute: 60,
  minutes: 60,
  hour: 3600,
  hours: 3600,
}

export function parseHibernationCommand(text, { verb = 'todd', direct = false } = {}) {
  let command = String(text || '').trim()
  if (!direct) {
    const addressed = command.match(new RegExp(`^${verb}[,:]?\\s+(.+)$`, 'i'))
    if (!addressed) return null
    command = addressed[1].trim()
  } else {
    command = command.replace(new RegExp(`^${verb}[,:]?\\s+`, 'i'), '').trim()
  }

  if (/^(?:show|list|what(?:'s| is))\s+(?:the\s+)?hibernation(?:\s+(?:policy|settings?))?\??$/i.test(command)) {
    return { action: 'show' }
  }

  const disable = command.match(/^(?:turn\s+)?hibernation\s+off\s+(?:for\s+)?(.+?)$/i)
    || command.match(/^turn\s+off\s+hibernation\s+(?:for\s+)?(.+?)$/i)
    || command.match(/^disable\s+hibernation\s+(?:for\s+)?(.+?)$/i)
  if (disable) return { action: 'disable', target: disable[1].trim() }

  const enable = command.match(/^(?:turn\s+)?hibernation\s+on\s+(?:for\s+)?(.+?)\s+(?:after|at)\s+(\d+)\s*(seconds?|minutes?|hours?)$/i)
    || command.match(/^turn\s+on\s+hibernation\s+(?:for\s+)?(.+?)\s+(?:after|at)\s+(\d+)\s*(seconds?|minutes?|hours?)$/i)
    || command.match(/^set\s+(.+?)\s+(?:hibernation|idle(?:\s+time)?)\s+(?:to|at)\s+(\d+)\s*(seconds?|minutes?|hours?)$/i)
    || command.match(/^hibernate\s+(.+?)\s+after\s+(\d+)\s*(seconds?|minutes?|hours?)$/i)
  if (!enable) return null
  const amount = Number(enable[2])
  const unit = enable[3].toLowerCase()
  if (!Number.isSafeInteger(amount) || amount <= 0) return { action: 'invalid-duration' }
  return { action: 'enable', target: enable[1].trim(), idleSeconds: amount * DURATION_UNITS[unit] }
}

export function normalizedPolicies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [agentId, policy] of Object.entries(value)) {
    const idleSeconds = Number(policy?.idleSeconds)
    if (!/^fleet:[a-z0-9_-]+$/i.test(agentId)) continue
    if (!Number.isSafeInteger(idleSeconds) || idleSeconds <= 0) continue
    result[agentId] = { enabled: policy?.enabled === true, idleSeconds }
  }
  return result
}

export function dueHibernations(policies, trustedIdleSeconds, inFlight = new Set()) {
  const due = []
  const explicit = normalizedPolicies(policies)
  const defaultIdleSeconds = 20 * 60
  for (const [agentId, idleValue] of Object.entries(trustedIdleSeconds || {})) {
    const policy = explicit[agentId] || { enabled: true, idleSeconds: defaultIdleSeconds }
    if (!policy.enabled || inFlight.has(agentId)) continue
    const idleSeconds = Number(idleValue)
    if (Number.isFinite(idleSeconds) && idleSeconds >= policy.idleSeconds) {
      due.push({ agentId, idleSeconds, thresholdSeconds: policy.idleSeconds })
    }
  }
  return due
}

export function formatDuration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}
