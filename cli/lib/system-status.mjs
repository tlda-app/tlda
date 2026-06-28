function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : 'unknown'
}

function formatDirty(dirty) {
  if (dirty === true) return 'dirty'
  if (dirty === false) return 'clean'
  return 'unknown'
}

function formatIdentity(identity) {
  if (!identity?.available) return `unavailable${identity?.reason ? ` (${identity.reason})` : ''}`
  return `${shortSha(identity.gitSha)} ${identity.ref || 'unknown'} ${formatDirty(identity.dirty)}${identity.isWorktree ? ' worktree' : ''}`
}

export function formatSystemStatus(data) {
  const lines = []
  lines.push('System status')
  lines.push(`Server: ${data.server?.mode || 'unknown'} config=${data.server?.config || 'unknown'} fleet_db=${data.server?.fleet_db || 'default'}`)
  lines.push(`  checkout: ${formatIdentity(data.server?.identity)}`)
  const deploy = data.deploy || {}
  if (deploy.unavailable) {
    lines.push(`Deploy stamp: unavailable${deploy.reason ? ` (${deploy.reason})` : ''}`)
  } else {
    lines.push(`Deploy stamp: ${shortSha(deploy.gitSha || deploy.sha)} ${deploy.ref || 'unknown'} ${formatDirty(deploy.dirty)}${deploy.builtAt ? ` builtAt=${deploy.builtAt}` : ''}`)
  }

  const daemons = Array.isArray(data.daemon) ? data.daemon : []
  lines.push(`Daemons: ${daemons.length}`)
  for (const d of daemons) {
    const connected = d.connected ? 'connected' : 'disconnected'
    lines.push(`  ${d.machine_id}: ${connected} install=${d.install_path || 'unknown'}`)
    lines.push(`    checkout: ${formatIdentity(d.identity)}`)
  }

  const fleet = data.fleet || {}
  lines.push(`Agents: ${fleet.live ?? 0} live / ${fleet.total ?? 0} total`)
  const byMachine = fleet.byMachine || {}
  for (const machine of Object.keys(byMachine).sort()) {
    lines.push(`  ${machine}: ${byMachine[machine]}`)
  }
  return `${lines.join('\n')}\n`
}
