// P1 server admission for `never-joined` daemon verdicts. The daemon decides
// from process evidence; the server verifies ownership, dedupes durably, and
// writes down what it is told — it decides nothing.
//
// Ownership: the claiming daemon_key must equal the spawn-target key recorded
// on the shell row at mint; rows predating that write fall back to the
// agent-daemon route (the server's existing ownership signal). Anything else
// is rejected and logged — fail closed.
//
// Idempotency (chief-apprentice amend): admission is idempotent on
// (mint_id, verdict), marked durably in agent metadata. A re-delivered
// verdict is acknowledged without re-retiring, re-recording, or re-noticing.
// A *changed* verdict for the same mint (leaked-alive, then absent when the
// process dies) is a different pair and processes normally.
//
// Effects. absent on a live row: retirePendingShell + mailbox failed +
// owner notice. absent on an already-dead row: marker only (death was
// already surfaced; staying silent is correct). leaked-alive: mailbox
// indeterminate + exactly one owner notice naming the process — no shell or
// task change, dead or live. Owner is the open task's delegated_by (the
// waiter), else a live mailbox's owner; with neither, the verdict is
// recorded but no notice is addressed.

// F3(a) send leg: after the server declares a launch failed, tell the owning
// daemon so it can examine its mint row now (a live process emits the P1
// leaked-alive verdict through the normal path) rather than waiting for the
// sweep. Routing prefers the live agent-daemon route and falls back to the
// spawn-target key recorded at mint; with neither there is no daemon to tell.
// Fire-and-forget by contract: the death is already recorded, a lost notice
// only delays the daemon's own examination, and a send failure must never
// fail the loud path. Returns true when a notice was sent.
export async function notifyOwningDaemonOfFailure(deps, agentId, reason) {
  const { store, send, log } = deps
  const warn = message => { try { log?.warn?.(message) } catch { /* log sink is best-effort */ } }
  try {
    if (!agentId) return false
    const agent = await store.getAgent?.(agentId)
    if (!agent) return false
    const route = await store.getAgentDaemonRoute?.(agentId)
    const daemonKey = route?.daemon_key || agent.metadata?.spawn_daemon_key || null
    if (!daemonKey) {
      warn(`launch-failed notice for ${agentId} dropped: no owning daemon resolvable`)
      return false
    }
    await send(daemonKey, 'launch-failed-server-side', { agent_id: agentId, reason: reason || 'launch-failed' })
    return true
  } catch (error) {
    // Total by contract: the notice reconciles, it is not the death, so no
    // failure here — store, route, or send — may propagate to the loud path.
    // Swallowing is the design (F3 notice-only), not a fallback.
    warn(`launch-failed notice for ${agentId} failed: ${error?.message || error}`)
    return false
  }
}

export async function admitNeverJoinedVerdict(deps, msg) {
  const { store, mailbox, chat, completeMailbox, log } = deps
  // Logging must never break admission: a warn sink throwing would turn a
  // rejected verdict into a 500-class failure.
  const fail = (...args) => { try { log?.warn?.(...args) } catch { /* log sink is best-effort */ } }
  const verdict = msg?.verdict
  const mintId = msg?.mint_id
  const session = msg?.observed?.session
  if ((verdict !== 'absent' && verdict !== 'leaked-alive') || !mintId || !session) {
    return { agentId: null, changed: false, ignored: 'shape' }
  }
  const claimKey = msg.daemon_key || null
  let agent = msg.agent_id ? await store.getAgent?.(msg.agent_id) : null
  if (!agent) {
    const foundId = await store.findAgentByDaemonMintId?.(mintId)
    if (foundId) agent = await store.getAgent?.(foundId)
  }
  if (!agent) {
    fail(`never-joined ${verdict} for unknown agent (mint ${mintId}): ignored`)
    return { agentId: null, changed: false, ignored: 'unknown-agent' }
  }
  const recordedKey = agent.metadata?.spawn_daemon_key || null
  let owned = false
  if (claimKey) {
    if (recordedKey) {
      owned = claimKey === recordedKey
    } else {
      // Rollout stage (AGENTS.md: temporary, not permanent): rows minted
      // before the spawn-key write deployed carry no key, so verify against
      // the live agent-daemon route instead. Retire this branch by
      // backfilling spawn_daemon_key from the live route for all pre-deploy
      // rows that have one; unrouted old rows reject identically either
      // way, so once the backfill lands this branch is dead code. Delete it
      // then — do not let it become permanent by nobody's decision.
      const route = await store.getAgentDaemonRoute?.(agent.id)
      owned = !!route && claimKey === route.daemon_key
    }
  }
  if (!owned) {
    fail(`never-joined ${verdict} for ${agent.id} rejected: daemon_key mismatch (mint ${mintId})`)
    return { agentId: agent.id, changed: false, ignored: 'ownership' }
  }
  const done = (agent.metadata && typeof agent.metadata === 'object' ? agent.metadata.never_joined_verdicts : null) || {}
  if (done[verdict]?.mint_id === mintId) {
    return { agentId: agent.id, changed: false, duplicate: true }
  }
  const mark = () => store.updateAgentMeta?.(agent.id, {
    never_joined_verdicts: { ...done, [verdict]: { mint_id: mintId, ts: new Date().toISOString() } },
  })
  const label = agent.friendly_name || agent.id
  const dead = !!agent.dead
  if (verdict === 'absent' && dead) {
    await mark()
    return { agentId: agent.id, changed: false }
  }
  const liveEntry = mailbox?.entries?.all?.().find(e => e?.kind === 'spawn' && e?.status === 'pending' && e?.meta?.agentId === agent.id) || null
  const tasks = await store.getActiveTasksByAgent?.(agent.id) || []
  const ownerId = tasks[0]?.delegated_by || liveEntry?.ownerId || null
  const entry = liveEntry || { kind: 'spawn', id: null, ownerId, meta: { agentId: agent.id, name: label } }
  const detail = {
    label,
    agentId: agent.id,
    mint_id: mintId,
    session,
    daemon_key: claimKey,
    checked_at: msg.observed?.checked_at || null,
    reason: msg.reason || (verdict === 'absent' ? 'never-joined' : 'leaked-alive'),
  }
  if (verdict === 'absent') {
    await store.retirePendingShell?.(agent.id)
    if (liveEntry && mailbox?.fail) {
      const settled = mailbox.fail(liveEntry.id, 'never-joined', { verdict, ...detail })
      if (settled) completeMailbox?.(settled, 'failed', { ...detail, mailbox_id: settled.id })
    } else {
      completeMailbox?.(entry, 'failed', detail)
    }
    await mark()
    if (ownerId) {
      await chat?.('fleet:tlda', ownerId,
        `**\`${label}\` never joined and its process is gone** — shell retired, task retracted.\n\nagent_id: \`${agent.id}\` · mint: \`${mintId}\` · session: \`${session}\``,
        { type: 'spawn_never_joined', verdict: 'absent', mailbox_id: liveEntry?.id || null, agent_id: agent.id, mint_id: mintId })
    } else {
      fail(`never-joined absent for ${agent.id} recorded without notice: no owner resolvable`)
    }
    return { agentId: agent.id, changed: true }
  }
  if (liveEntry && mailbox?.indeterminate) {
    const settled = mailbox.indeterminate(liveEntry.id, 'leaked-alive', { verdict, ...detail })
    if (settled) completeMailbox?.(settled, 'indeterminate', { ...detail, mailbox_id: settled.id })
  } else {
    completeMailbox?.(entry, 'indeterminate', detail)
  }
  await mark()
  if (ownerId) {
    await chat?.('fleet:tlda', ownerId,
      `**\`${label}\` is alive but never joined** — process \`${session}\` on \`${claimKey}\`${detail.checked_at ? ` at ${detail.checked_at}` : ''}, no login. Rejoin it, or reap it: \`tlda agent hibernate ${label}\` on that machine kills by its recorded session.\n\nagent_id: \`${agent.id}\` · mint: \`${mintId}\``,
      { type: 'spawn_never_joined', verdict: 'leaked-alive', mailbox_id: liveEntry?.id || null, agent_id: agent.id, mint_id: mintId })
  } else {
    fail(`never-joined leaked-alive for ${agent.id} recorded without notice: no owner resolvable`)
  }
  return { agentId: agent.id, changed: true }
}
