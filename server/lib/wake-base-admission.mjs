// Server admission for `wake-base-resolved` daemon verdicts. The daemon
// resolved a resume to a config base other than the configured one — a
// substitution of surfaces the agent must be told about, never a silent
// fallback. Same contract as `never-joined`: the daemon decides from box
// evidence, the server verifies ownership, dedupes durably, and writes down
// what it is told.
//
// Effects: metadata.wakeBase records the resolution durably, and
// pendingReturnNotice parks the announcement where the agent's login hands it
// over (the reanimate precedent: login is the only moment the agent can be
// told anything). No chat push: nobody is waiting on a wake, and the woken
// agent itself is the interested party.

function describeBase(side) {
  if (!side) return 'an unknown base'
  if (side.kind === 'default') return `the default Claude base (\`${side.path || '~/.claude'}\`)`
  if (side.kind === 'bundle') return `the \`${side.name || 'lane'}\` lane bundle (\`${side.path || '?'}\`)`
  return `\`${side.path || '?'}\``
}

export function wakeBaseNoticeText({ sessionId, resolved, configured }) {
  return `Wake note: session \`${sessionId || '(unknown)'}\` was resumed from ${describeBase(resolved)}, `
    + `not your configured ${describeBase(configured)} — the lane bundle is not in play for this process, `
    + `so lane skills may be unavailable. Your history is intact; say the word if you need the lane surface back.`
}

export async function admitWakeBaseResolved(deps, msg) {
  const { store, log } = deps
  const fail = (...args) => { try { log?.warn?.(...args) } catch { /* log sink is best-effort */ } }
  const agentId = msg?.agent_id
  const sessionId = msg?.session_id
  const resolved = msg?.resolved
  const configured = msg?.configured
  if (!agentId || !sessionId || !resolved?.path || !configured?.path) {
    return { agentId: agentId || null, changed: false, ignored: 'shape' }
  }
  const agent = await store.getAgent?.(agentId)
  if (!agent) {
    fail(`wake-base-resolved for unknown agent ${agentId} (session ${sessionId}): ignored`)
    return { agentId, changed: false, ignored: 'unknown-agent' }
  }
  const claimKey = msg.daemon_key || null
  const recordedKey = agent.metadata?.spawn_daemon_key || null
  let owned = false
  if (claimKey) {
    if (recordedKey) {
      owned = claimKey === recordedKey
    } else {
      const route = await store.getAgentDaemonRoute?.(agent.id)
      owned = !!route && claimKey === route.daemon_key
    }
  }
  if (!owned) {
    fail(`wake-base-resolved for ${agent.id} rejected: daemon_key mismatch (session ${sessionId})`)
    return { agentId: agent.id, changed: false, ignored: 'ownership' }
  }
  const meta = (agent.metadata && typeof agent.metadata === 'object') ? agent.metadata : {}
  if (meta.wakeBase?.session_id === sessionId && meta.wakeBase?.resolved?.path === resolved.path) {
    return { agentId: agent.id, changed: false, duplicate: true }
  }
  const notice = wakeBaseNoticeText({ sessionId, resolved, configured })
  const pending = meta.pendingReturnNotice
  await store.updateAgentMeta?.(agent.id, {
    wakeBase: {
      session_id: sessionId,
      resolved: { kind: resolved.kind || null, name: resolved.name || null, path: resolved.path },
      configured: { path: configured.path },
      ts: new Date().toISOString(),
    },
    // Never clobber a parked notice (reanimate parks here too): deliver both.
    pendingReturnNotice: pending && pending !== notice ? `${pending}\n\n${notice}` : notice,
  })
  return { agentId: agent.id, changed: true }
}
