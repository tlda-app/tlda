export const NO_CAP = null

function bindingsForDaemon(processBindings, daemonKey) {
  const rows = []
  for (const row of processBindings) {
    if (!row || !row.tmuxSession) continue
    if (daemonKey && row.daemonKey !== daemonKey) continue
    rows.push(row)
  }
  return rows
}

function seenAt(row) {
  const value = Date.parse(row?.lastSeen || row?.updatedAt || '')
  return Number.isFinite(value) ? value : 0
}

// One awake agent per live tmux session: the binding that currently occupies it.
//
// A binding records a session by name, and names are reused -- `fleet-dev` and
// `fleet-chief` are stable seats that many successive processes have held. So
// "this binding's session name is live" is true of every binding that ever held
// the name, including ones whose process exited weeks ago. Occupancy is what
// separates them: the most recently seen binding on a live session is the one
// running in it, and the rest are history that happens to share a name.
export function awakeLocalAgentBindings({ processBindings = [], sessionNames = [], daemonKey = null } = {}) {
  const live = new Set(sessionNames)
  const occupant = new Map()
  for (const row of bindingsForDaemon(processBindings, daemonKey)) {
    if (!live.has(row.tmuxSession)) continue
    const held = occupant.get(row.tmuxSession)
    if (!held || seenAt(row) > seenAt(held)) occupant.set(row.tmuxSession, row)
  }
  return [...occupant.values()]
}

// `probed: false` means the tmux probe failed. Returning 0 there would read as
// an empty box and let every launch through, so it returns null and the caller
// refuses instead.
export function countAwakeLocalAgents({ processBindings = [], sessionNames = [], probed = true, daemonKey = null } = {}) {
  if (!probed) return null
  return awakeLocalAgentBindings({ processBindings, sessionNames, daemonKey }).length
}

export function agentCapFromConfig(config) {
  const value = config?.agentCap
  if (value === undefined || value === null) return NO_CAP
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`daemon.yaml: agentCap must be a non-negative integer or absent (got ${JSON.stringify(value)})`)
  }
  return value
}

// What `tlda agent cap [N|none]` was asked to do.
//
// A missing positional is `null`, not `undefined`, so a truthiness or
// `=== undefined` test reads a bare `tlda agent cap` as "set the cap to
// nothing" and writes 0 into daemon.yaml. A read command must never write, so
// absence is checked explicitly and is the only thing that yields `read`.
export function agentCapCommandPlan(positional) {
  if (positional === null || positional === undefined || positional === '') return { action: 'read' }
  const raw = String(positional).trim()
  if (raw.toLowerCase() === 'none') return { action: 'clear' }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`agent cap takes a non-negative whole number or \`none\` (got ${JSON.stringify(positional)})`)
  }
  return { action: 'set', cap: Number(raw) }
}

export function agentCapRefusal(operation, { cap = NO_CAP, awake = null, daemonKey = null, probeError = null } = {}) {
  if (cap === NO_CAP) return null
  const where = daemonKey || 'this daemon'
  if (awake === null) {
    return `${operation} refused: agent cap is ${cap} and the tmux probe for ${where} failed, `
      + 'so the number of awake agents is unknown. An unknown count is refused rather than '
      + `read as an empty box. tmux reported: ${probeError || '(no error text captured)'}`
  }
  if (awake < cap) return null
  return `${operation} refused: ${awake} agent${awake === 1 ? '' : 's'} awake on ${where}, cap is ${cap}. `
    + 'Nothing was queued — this launch is declined, not deferred. '
    + `Hibernate one, or raise the ceiling with \`tlda agent cap ${awake + 1}\`.`
}
