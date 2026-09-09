export function createSourceProposalAdmissionHandler({
  parseDaemonProposalRef, sourceLifecycleStore, listProposalRefs, admitProposal,
  updateProject, recordServerPerfEvent, performanceNow = () => performance.now(), nowMs = () => Date.now(),
  log = message => console.warn(message), slowThresholdMs = 50,
}) {
  return async function handleSourceProposalAdmission(ws, msg, context = {}) {
    const { project, ref, revision } = msg
    const receivedAt = context.receivedAt ?? performanceNow()
    const startedAt = performanceNow()
    const stages = []
    let activeStage = 'validation'
    let proposalCount = null
    let proposalFound = false
    let hasCurrentLifecycle = false
    const timed = async (stage, fn) => {
      activeStage = stage
      const start = performanceNow()
      try { return await fn() } finally { stages.push({ stage, durationMs: performanceNow() - start }) }
    }
    let ok = false
    let error = null
    try {
      const parsed = parseDaemonProposalRef(ref, ws._daemonKey)
      if (!parsed || parsed.revision !== revision) throw new Error(`invalid proposal ref for ${ws._daemonKey || 'unknown daemon'}`)
      const lifecycle = await timed('lifecycle-store', () => sourceLifecycleStore(project))
      const git = await timed('git-repository', () => lifecycle.gitRepository())
      const proposals = await timed('proposal-enumeration', () => listProposalRefs(git.gitDir))
      proposalCount = proposals.length
      const proposal = proposals.find(item => item.ref === ref && item.revision === revision)
      proposalFound = !!proposal
      if (!proposal) throw new Error(`${project}: proposal ref is not present`)
      hasCurrentLifecycle = lifecycle.listRevisionLifecycles(project).some(item => item.sourceRevision === revision)
      const row = await timed('queue-admission', () => admitProposal({ project, ...proposal }, { retryTerminal: msg.retry_terminal === true || !hasCurrentLifecycle }))
      // Stamp who caused this revision, so the build card can be addressed to
      // them. `resolveEditedBy` reads exactly this pair and requires it inside a
      // ten-minute window; nothing had written it since f6d0f9089 on 08-20, so it
      // returned null for every project and no agent had received a build card
      // since 08-21. The daemon resolves the name from its own edit records --
      // see resolveProposalEditor in bin/fleet-daemon.mjs -- and this is where it
      // lands.
      //
      // Best-effort on purpose: a failed stamp costs a name on a chat message,
      // and must not fail an admission that already succeeded.
      if (msg.editedBy) {
        try {
          await timed('attribution', () => updateProject(project, { lastEditedBy: msg.editedBy, lastEditedByAt: nowMs() }))
        } catch (e) {
          // Swallowed deliberately: the admission above already SUCCEEDED and the
          // revision is durable. Rethrowing would turn a missing name on a chat
          // message into a failed push the daemon then retries.
          console.error(`[${project}] recording edit attribution failed: ${e.message}`)
        }
      }
      if (msg.id) ws.send(JSON.stringify({ id: msg.id, result: { ok: true, project, revision, submissionId: row.id, state: row.state, startedOnce: row.started_once === 1, terminalReason: row.terminal_reason || null, lifecyclePresent: hasCurrentLifecycle } }))
      ok = true
    } catch (e) {
      error = e
      if (msg.id) ws.send(JSON.stringify({ id: msg.id, error: e.message }))
    } finally {
      const detail = { project, ref, revision, queuedMs: startedAt - receivedAt, totalMs: performanceNow() - receivedAt, stages, proposalCount, proposalFound, hasCurrentLifecycle, ok, ...(error ? { error: error.message, errorStage: activeStage } : {}) }
      recordServerPerfEvent('source-proposal-admit', detail)
      if (!ok || detail.totalMs >= slowThresholdMs) log(`[source-proposal-admit] ${JSON.stringify(detail)}`)
    }
  }
}

export function createSourceProposalAdmissionDispatcher(dispatch, onError = () => {}, performanceNow = () => performance.now()) {
  const chains = new Map()
  return function enqueue(msg) {
    const receivedAt = performanceNow()
    const project = String(msg.project || '')
    const previous = chains.get(project) || Promise.resolve()
    const current = previous.then(() => dispatch(msg, { receivedAt })).catch(onError)
    chains.set(project, current)
    void current.finally(() => { if (chains.get(project) === current) chains.delete(project) })
    return current
  }
}

export function createSourceProposalAdmissionConnectionDispatcher({ ws, handleEnvelope, handler, onHandlerError, onDispatchError, performanceNow }) {
  const dispatch = (msg, context = {}) => handleEnvelope(ws, msg, (handlerWs, handlerMsg) => handler(handlerWs, handlerMsg, context), { onHandlerError })
  return createSourceProposalAdmissionDispatcher(dispatch, onDispatchError, performanceNow)
}
