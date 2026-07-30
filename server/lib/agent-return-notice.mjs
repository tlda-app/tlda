function timestampMs(value) {
  if (!value) return null
  const ms = Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

export async function agentAwaySinceMs(agent, {
  status = 'hibernating',
  getCurrentRuntimeState,
} = {}) {
  const runtime = agent?.id && typeof getCurrentRuntimeState === 'function'
    ? await getCurrentRuntimeState(agent.id)
    : null
  if (runtime?.status === status) return timestampMs(runtime.from_ts)
  return timestampMs(agent?.last_seen)
    || timestampMs(agent?.registered_at)
}

export function formatAwayDuration(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return 'less than a minute'
  const units = [
    ['day', 24 * 60 * 60_000],
    ['hour', 60 * 60_000],
    ['minute', 60_000],
  ]
  for (const [name, size] of units) {
    const n = Math.floor(ms / size)
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'}`
  }
  return 'less than a minute'
}

export async function agentReturnNotice(agent, status = 'hibernating', {
  reanimated = false,
  getCurrentRuntimeState,
  now = () => Date.now(),
} = {}) {
  const sinceMs = await agentAwaySinceMs(agent, { status, getCurrentRuntimeState })
  const duration = sinceMs ? formatAwayDuration(now() - sinceMs) : 'an unknown amount of time'
  const lines = [`You were away as ${status} for ${duration}.`]
  if (reanimated) {
    lines.push('You were killed and reanimated.')
    lines.push('Your open tasks were retired when you were killed.')
  }
  return lines.join('\n')
}

export async function withAgentReturnNotice(agent, nudgeText, status = 'hibernating', opts = {}) {
  const notice = await agentReturnNotice(agent, status, opts)
  return nudgeText ? `${notice}\n\n${nudgeText}` : notice
}
