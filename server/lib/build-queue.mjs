import { BuildQueueStore } from './build-queue-store.mjs'

export function createBuildQueue({
  transport,
  getProjectsDir,
  relayMessage,
  recordDisposition = async () => {},
  getCurrentHead = async () => null,
  isAncestor = async (ancestor, descendant) => ancestor === descendant,
  random = Math.random,
  store = new BuildQueueStore(),
  serializeProject = async (_project, operation) => operation(),
  logError = (name, error) => console.error(`[build-queue] worker error for ${name}: ${error.message}`),
}, options = {}) {
  const configured = Number(options.maxConcurrency)
  const maxConcurrency = Number.isFinite(configured) && configured >= 1 ? configured : 2
  const buildPriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 10
  // How long a build may say NOTHING before its slot is taken back.
  //
  // This is a worker-liveness threshold, not a duration limit. A build worker
  // sends heartbeats independently of renderer output, so a long, quiet R
  // chunk remains live while a suspended worker still loses its slot.
  //
  // 90s is six missed seconds-apart flushes. Set to 0 to disable, which is what
  // a test does when it drives the clock itself.
  const configuredStall = Number(options.stallTimeoutMs)
  const stallTimeoutMs = Number.isFinite(configuredStall) && configuredStall >= 0 ? configuredStall : 90_000
  // Deliberately NOT an injectable clock. An injected `now` looks testable and
  // is not: the watchdog below is a real `setInterval`, so a test that advances
  // a fake clock proves the arithmetic and never runs the timer that has to
  // fire. The test sets a small threshold and waits instead, which exercises
  // the path that actually ships.
  const now = Date.now
  const running = new Map()
  let activeCount = 0
  let transitions = Promise.resolve()

  function transition(operation) {
    const current = transitions.then(operation, operation)
    transitions = current.catch(() => {})
    return current
  }

  const jobFromRow = row => ({
    id: row.id,
    acceptSeq: row.id,
    name: row.project,
    kind: row.kind,
    sourceRevision: row.revision,
    daemonId: row.daemon_id,
    branch: row.branch,
    integerPriority: row.integer_priority,
    fractionalPriority: row.fractional_priority,
    priority: row.priority,
    startedOnce: row.started_once === 1,
  })

  async function settle(row, state, result = null) {
    const terminal = state === 'complete' ? 'complete' : state === 'failed' ? 'failed' : 'killed'
    const saved = store.settle(row.id, terminal, result?.reason || result?.error || null)
    if (!saved) return
    await recordDisposition(jobFromRow(saved), terminal, result)
  }

  async function thinPending(project = null) {
    const pending = store.list('pending', project)
    const remove = new Set()
    for (const ancestor of pending) {
      for (const descendant of pending) {
        if (ancestor.id === descendant.id || ancestor.project !== descendant.project) continue
        if (await isAncestor(ancestor.revision, descendant.revision, ancestor.project)) {
          remove.add(ancestor.id)
          break
        }
      }
    }
    for (const row of pending) {
      if (!remove.has(row.id)) continue
      await settle(row, 'killed', { reason: 'superseded', byPendingDescendant: true, thinned: true })
    }
  }

  async function killNeedingRebase(project, head) {
    for (const row of store.list().filter(candidate => (
      candidate.project === project && ['pending', 'running'].includes(candidate.state)
    ))) {
      if (head && await isAncestor(head, row.revision, project)) continue
      if (!head) continue
      if (row.state === 'pending') await settle(row, 'killed', { reason: 'needs-rebase', pending: true })
      else running.get(row.id)?.cancel('needs-rebase')
    }
  }

  async function drain() {
    while (activeCount < maxConcurrency) {
      const pending = store.list('pending')
      if (!pending.length) break
      const row = store.start(pending[0].id)
      if (!row) continue
      start(row)
    }
  }

  function start(row) {
    const job = jobFromRow(row)
    let workerFailure = null
    let cancelled = false
    let relays = Promise.resolve()
    let lastHeard = now()
    activeCount += 1

    // A slot used to come back ONLY when the worker process exited, and nothing
    // anywhere put a bound on that. A worker that stopped -- one was found
    // suspended in state T for 34 minutes, 0.2% CPU, on an idle box -- kept its
    // slot for good, so the queue ran at reduced capacity until the server was
    // restarted, and with every slot held it stopped building anything at all
    // while each edit still logged as admitted.
    //
    // An in-process timeout could never have caught it. The worker's own timers
    // are frozen along with the rest of it, which is why the per-command
    // `timeout: 120000` in build-runner never fired. The bound has to be held by
    // the parent, and this is the parent.
    //
    // Not a death, and deliberately not called one: the submission is settled as
    // FAILED, which is what it is -- a build that did not work. The revision is
    // proposed again afterwards, which is safe because sync re-derives rather
    // than depending on any single attempt having succeeded.
    const stallTimer = stallTimeoutMs > 0 ? setInterval(() => {
      if (cancelled || !running.has(row.id)) return
      const silentFor = now() - lastHeard
      if (silentFor < stallTimeoutMs) return
      const stalled = new Error(
        `build produced no output for ${Math.round(silentFor / 1000)}s; treating the build as stalled and releasing its slot`,
      )
      logError(job.name, stalled)
      // `workerFailure`, NOT `cancelled`. onExit reads cancelled as 'killed',
      // which is the word for something somebody asked to stop; nobody asked
      // for this. A stall is a build that failed, and it settles as failed.
      workerFailure = stalled
      running.get(row.id)?.handle?.cancel?.()
    }, Math.max(100, Math.floor(stallTimeoutMs / 4))) : null
    stallTimer?.unref?.()

    function relay(message, channel) {
      // ANY message is proof the worker's event loop is running. In particular,
      // heartbeats do not depend on a renderer producing stdout.
      lastHeard = now()
      if (message?.t === 'heartbeat') return
      if (message?.t === 'done' && message.ok === false) workerFailure = new Error(message.error || `build worker for ${job.name} failed`)
      relays = relays.then(async () => {
        if (message?.t === 'rpc') {
          try {
            const result = await relayMessage?.(job.name, message, job)
            channel?.send?.({ t: 'rpc-result', id: message.id, ok: true, result })
          } catch (error) {
            channel?.send?.({ t: 'rpc-result', id: message.id, ok: false, error: error?.message || String(error) })
          }
          return
        }
        await relayMessage?.(job.name, message, job)
      }).catch(error => logError(job.name, error))
    }

    async function onExit(code) {
      if (stallTimer) clearInterval(stallTimer)
      await relays
      if (!running.delete(row.id)) return
      activeCount = Math.max(0, activeCount - 1)
      if (!workerFailure && !cancelled && code) workerFailure = new Error(`build worker for ${job.name} exited with code ${code}`)
      const completion = transition(async () => {
        await settle(
          row,
          cancelled ? 'killed' : workerFailure ? 'failed' : 'complete',
          workerFailure
            ? { error: workerFailure.message, exitCode: code }
            : cancelled
              ? { reason: job.cancelReason || 'cancelled', exitCode: code }
              : { exitCode: code },
        )
        await drain()
      })
      await completion
    }

    const handle = transport.start({
      ...job,
      projectsDir: getProjectsDir(),
      osPriority: buildPriority,
    }, { onMessage: relay, onError: error => logError(job.name, error), onExit })
    running.set(row.id, {
      ...job,
      handle,
      cancel(reason = 'cancelled') {
        cancelled = true
        job.cancelReason = reason
        handle.cancel()
      },
    })
  }

  function admitBuild(project, { revision, daemonId, branch = 'main', kind = 'build' }, { retryTerminal = false } = {}) {
    if (!project || !revision || !daemonId || !branch) return Promise.reject(new Error('project, revision, daemonId, and branch are required'))
    return serializeProject(project, () => transition(async () => {
      let admittedRow = store.get(project, revision)
      if (admittedRow && retryTerminal && ['complete', 'failed', 'killed'].includes(admittedRow.state)) {
        store.removeTerminalRevision(project, revision)
        admittedRow = null
      }
      if (!admittedRow) {
        const fractionalPriority = random()
        if (!(fractionalPriority >= 0 && fractionalPriority < 1)) throw new Error('build queue random source must return a value in [0, 1)')
        const head = await getCurrentHead(project)
        const valid = !head || await isAncestor(head, revision, project)
        admittedRow = store.admit({
          project, revision, daemonId, branch, kind, fractionalPriority,
          state: valid ? 'pending' : 'killed',
          reason: valid ? null : 'needs-rebase',
        }).row
      }
      if (!['complete', 'failed', 'killed'].includes(admittedRow.state)) {
        await thinPending(project)
        await drain()
      }
      return admittedRow
    }))
  }

  async function publishedHeadChanged(project, head) {
    return transition(async () => {
      await killNeedingRebase(project, head)
      await thinPending(project)
      await drain()
    })
  }

  async function recover() {
    return transition(() => drain())
  }

  async function killBuild(project) {
    return transition(async () => {
      for (const row of store.list('pending', project)) await settle(row, 'killed', { reason: 'cancelled', pending: true })
      for (const job of running.values()) if (job.name === project) job.cancel()
    })
  }

  async function killAllDispatchedBuilds() {
    return transition(async () => {
      for (const row of store.list('pending')) await settle(row, 'killed', { reason: 'cancelled', pending: true })
      for (const job of running.values()) job.cancel()
    })
  }

  async function removeProject(project) {
    return transition(async () => {
      for (const job of running.values()) if (job.name === project) job.cancel('project-deleted')
      const removed = store.removeProject(project)
      await drain()
      return removed
    })
  }

  const isBuilding = project => store.list().some(row => row.project === project && ['pending', 'running'].includes(row.state))
  const isBuildKindPending = (project, kind = 'build') => store.list().some(row => (
    row.project === project && row.kind === kind && ['pending', 'running'].includes(row.state)
  ))
  const inspect = () => ({
    pending: store.list('pending').map(jobFromRow),
    running: store.list('running').map(jobFromRow),
    ring: store.ring(),
    all: store.list().map(jobFromRow),
  })

  return {
    admitBuild,
    publishedHeadChanged,
    recover,
    killBuild,
    killAllDispatchedBuilds,
    removeProject,
    isBuilding,
    isBuildKindPending,
    inspect,
    store,
  }
}
