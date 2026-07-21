export function projectJsonlAgentsFromProcessBindings(rows = [], { daemonKey } = {}) {
  return rows
    .filter(row =>
      row?.id &&
      row.sessionId &&
      row.sessionKind &&
      row.tmuxSession &&
      row.cwd &&
      row.daemonKey === daemonKey
    )
    .map(row => ({
      id: row.id,
      friendly_name: row.friendlyName || row.id,
      session_id: row.sessionId,
      session_ids: [row.sessionId],
      session_path: row.sessionPath || null,
      tmux_session: row.tmuxSession,
      cwd: row.cwd,
      runtimeKind: row.sessionKind,
      metadata: { kind: row.sessionKind, model: row.model || null },
      machine_id: row.machineId || null,
      env_name: row.envName || null,
      daemon_key: row.daemonKey || null,
      terminal_capability: row.terminalCapability || null,
      dead: false,
      human: false,
    }))
}

export function jsonlProcessBindingSignature(rows = [], { daemonKey } = {}) {
  return projectJsonlAgentsFromProcessBindings(rows, { daemonKey })
    .map(agent => JSON.stringify({
      id: agent.id,
      session_id: agent.session_id,
      session_ids: agent.session_ids,
      session_path: agent.session_path,
      tmux_session: agent.tmux_session,
      cwd: agent.cwd,
      runtimeKind: agent.runtimeKind,
      kind: agent.metadata?.kind || null,
      machine_id: agent.machine_id,
      env_name: agent.env_name,
      daemon_key: agent.daemon_key,
    }))
    .sort()
    .join('\n')
}

export function createJsonlProcessBindingReconciler({
  listProcessBindings,
  sync,
  daemonKey,
  log = console,
} = {}) {
  let appliedSignature = ''
  let generation = 0

  return {
    async reconcile(reason = 'process-binding-change') {
      const rows = listProcessBindings?.() || []
      const nextSignature = jsonlProcessBindingSignature(rows, { daemonKey })
      if (nextSignature === appliedSignature) return false
      const bindingAgents = projectJsonlAgentsFromProcessBindings(rows, { daemonKey })
      const current = ++generation
      log?.info?.(`session watcher local bindings changed (${reason}); syncing live session tails`)
      await sync(bindingAgents)
      if (current === generation) appliedSignature = nextSignature
      return true
    },
    appliedSignature() {
      return appliedSignature
    },
  }
}
