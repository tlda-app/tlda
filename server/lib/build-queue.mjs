let nextSubmissionId = 1

export function createBuildQueue({
  transport,
  getProjectsDir,
  relayMessage,
  recordDisposition = async () => {},
  getCurrentHead = async () => null,
  isAncestor = async (ancestor, descendant) => ancestor === descendant,
  random = Math.random,
  logError = (name, e) => console.error(`[build-dispatch] worker error for ${name}: ${e.message}`),
}, options = {}) {
  const configured = Number(options.maxConcurrency)
  const maxConcurrency = Number.isFinite(configured) && configured >= 1 ? configured : 2
  const buildPriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 10
  const pending = new Map()
  const running = new Map()
  const ringPosition = new Map()
  let activeCount = 0
  let submissions = Promise.resolve()

  function daemonPosition(daemonId) {
    if (ringPosition.has(daemonId)) return ringPosition.get(daemonId)
    const back = ringPosition.size ? Math.min(...ringPosition.values()) - 1 : 0
    ringPosition.set(daemonId, back)
    return back
  }

  function daemonHasWork(daemonId) {
    return [...pending.values(), ...running.values()].some(job => job.daemonId === daemonId)
  }

  function removeIdleDaemon(daemonId) {
    if (!daemonHasWork(daemonId)) ringPosition.delete(daemonId)
  }

  function rotateDaemon(daemonId) {
    const others = [...ringPosition.entries()].filter(([id]) => id !== daemonId).map(([, p]) => p)
    ringPosition.set(daemonId, others.length ? Math.min(...others) - 1 : 0)
  }

  function settle(job, state, result = null) {
    return Promise.resolve(recordDisposition(job, state, result)).finally(() => {
      for (const waiter of job.waiters || []) {
        if (state === 'build_failed') waiter.reject(new Error(result?.error || `build worker for ${job.name} failed`))
        else waiter.resolve()
      }
      removeIdleDaemon(job.daemonId)
    })
  }

  async function thinFor(candidate) {
    for (const job of [...pending.values()]) {
      if (job.name !== candidate.name || job.kind !== candidate.kind || job.daemonId !== candidate.daemonId) continue
      if (!job.sourceRevision || !candidate.sourceRevision || job.sourceRevision === candidate.sourceRevision) continue
      if (await isAncestor(job.sourceRevision, candidate.sourceRevision, candidate.name)) {
        pending.delete(job.id)
        await settle(job, 'superseded', { bySourceRevision: candidate.sourceRevision, byAcceptSeq: candidate.acceptSeq, thinned: true })
      }
    }
  }

  async function needsRebase(job, head = undefined) {
    const current = head === undefined ? await getCurrentHead(job.name) : head
    return current !== job.basedOnRevision
  }

  async function removePendingNeedingRebase(name = null, head = undefined) {
    for (const job of [...pending.values()]) {
      if (name && job.name !== name) continue
      if (await needsRebase(job, head)) {
        pending.delete(job.id)
        await settle(job, 'cancelled', { reason: 'needs-rebase', pending: true })
      }
    }
  }

  function bestPending() {
    return [...pending.values()].sort((a, b) => b.priority - a.priority || a.id - b.id)[0] || null
  }

  async function drain() {
    await removePendingNeedingRebase()
    while (activeCount < maxConcurrency) {
      const job = bestPending()
      if (!job) break
      pending.delete(job.id)
      start(job)
    }
  }

  function start(job) {
    let workerFailure = null
    let cancelled = false
    let relays = Promise.resolve()
    activeCount++
    rotateDaemon(job.daemonId)

    function relay(msg, channel) {
      if (msg?.t === 'done' && msg.ok === false) workerFailure = new Error(msg.error || `build worker for ${job.name} failed`)
      relays = relays.then(async () => {
        if (msg?.t === 'rpc') {
          try {
            const result = await relayMessage?.(job.name, msg, job)
            channel?.send?.({ t: 'rpc-result', id: msg.id, ok: true, result })
          } catch (e) {
            channel?.send?.({ t: 'rpc-result', id: msg.id, ok: false, error: e?.message || String(e) })
          }
          return
        }
        await relayMessage?.(job.name, msg, job)
      }).catch(error => logError(job.name, error))
    }

    async function onExit(code) {
      await relays
      if (!running.delete(job.id)) return
      activeCount = Math.max(0, activeCount - 1)
      if (!workerFailure && !cancelled && code) workerFailure = new Error(`build worker for ${job.name} exited with code ${code}`)
      await settle(
        job,
        cancelled ? 'cancelled' : workerFailure ? 'build_failed' : 'built',
        workerFailure
          ? { error: workerFailure.message, exitCode: code }
          : cancelled
            ? { reason: job.cancelReason || 'cancelled', exitCode: code }
            : { exitCode: code },
      )
      await drain()
    }

    const handle = transport.start({ ...job, projectsDir: getProjectsDir(), osPriority: buildPriority }, {
      onMessage: relay,
      onError: error => logError(job.name, error),
      onExit,
    })
    running.set(job.id, {
      ...job,
      handle,
      cancel(reason = 'cancelled') {
        cancelled = true
        job.cancelReason = reason
        handle.cancel()
      },
    })
  }

  function dispatchBuild(name, submission = {}) {
    const { kind = 'build', sourceRevision, acceptSeq = null, daemonId, basedOnRevision } = submission
    let resolveCompletion, rejectCompletion
    const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject })
    submissions = submissions.then(async () => {
      if (!sourceRevision) throw new Error(`build submission for ${name} requires sourceRevision`)
      if (basedOnRevision === undefined) throw new Error(`build submission for ${name}@${sourceRevision} requires basedOnRevision`)
      if (!daemonId) throw new Error(`build submission for ${name}@${sourceRevision} requires daemonId`)
      const integerPriority = daemonPosition(daemonId)
      const fractionalPriority = random()
      if (!(fractionalPriority >= 0 && fractionalPriority < 1)) throw new Error('build queue random source must return a value in [0, 1)')
      const job = {
        id: nextSubmissionId++, name, kind, sourceRevision, acceptSeq, daemonId, basedOnRevision,
        integerPriority, fractionalPriority, priority: integerPriority + fractionalPriority,
        waiters: [{ resolve: resolveCompletion, reject: rejectCompletion }],
      }
      await thinFor(job)
      pending.set(job.id, job)
      await drain()
    }).catch(rejectCompletion)
    return completion
  }

  async function projectHeadChanged(name, head) {
    await submissions
    await removePendingNeedingRebase(name, head)
    for (const job of [...running.values()]) {
      if (job.name === name && await needsRebase(job, head)) job.cancel('needs-rebase')
    }
    await drain()
  }

  async function killBuild(name) {
    for (const job of [...pending.values()]) {
      if (job.name !== name) continue
      pending.delete(job.id)
      await settle(job, 'cancelled', { pending: true })
    }
    for (const job of running.values()) if (job.name === name) job.cancel()
  }

  async function killAllDispatchedBuilds() {
    for (const job of [...pending.values()]) {
      pending.delete(job.id)
      await settle(job, 'cancelled', { pending: true })
    }
    for (const job of running.values()) job.cancel()
  }

  function isBuilding(name) {
    return [...pending.values(), ...running.values()].some(job => job.name === name)
  }

  function isBuildKindPending(name, kind = 'build') {
    return [...pending.values(), ...running.values()].some(job => job.name === name && job.kind === kind)
  }

  function inspect() {
    return { pending: [...pending.values()], running: [...running.values()], ring: new Map(ringPosition) }
  }

  return { dispatchBuild, projectHeadChanged, killBuild, killAllDispatchedBuilds, isBuilding, isBuildKindPending, inspect }
}
