export function parseAgentMoveTarget(spec) {
  const raw = String(spec || '').trim()
  if (!raw) throw new Error('move target is required')

  let targetName = null
  let address = raw
  const at = raw.indexOf('@')
  if (at !== -1) {
    targetName = raw.slice(0, at).trim()
    address = raw.slice(at + 1).trim()
    if (!targetName) throw new Error(`invalid move target "${raw}": empty name before @`)
    if (!address) throw new Error(`invalid move target "${raw}": empty address after @`)
  }

  const parts = address.split(':')
  if (parts.length > 2) throw new Error(`invalid move target "${raw}": expected [name@][box:]env`)
  const machine_id = parts.length === 2 ? parts[0].trim() : null
  const env_name = (parts.length === 2 ? parts[1] : parts[0]).trim()
  if (parts.length === 2 && !machine_id) throw new Error(`invalid move target "${raw}": empty box before :`)
  if (!env_name) throw new Error(`invalid move target "${raw}": env is required`)

  return { targetName, machine_id, env_name }
}

export function daemonAddress(machineId, envName) {
  if (!machineId || !envName) return null
  return `${machineId}:${envName}`
}

export function describeAgentAddress(machineId, envName) {
  if (!machineId || !envName) return `${machineId || '(unknown)'}:${envName || '(unknown)'}`
  return `${machineId}:${envName}`
}
