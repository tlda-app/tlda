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
    activeCount += 1

    function relay(message, channel) {
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

  function admitBuild(project, { revision, daemonId, branch = 'main', kind = 'build' }) {
    let admittedRow
    const admission = transition(async () => {
      if (!project || !revision || !daemonId || !branch) throw new Error('project, revision, daemonId, and branch are required')
      admittedRow = await serializeProject(project, async () => {
        const existing = store.get(project, revision)
        if (existing) return existing
        const fractionalPriority = random()
        if (!(fractionalPriority >= 0 && fractionalPriority < 1)) throw new Error('build queue random source must return a value in [0, 1)')
        const head = await getCurrentHead(project)
        const valid = !head || await isAncestor(head, revision, project)
        return store.admit({
          project, revision, daemonId, branch, kind, fractionalPriority,
          state: valid ? 'pending' : 'killed',
          reason: valid ? null : 'needs-rebase',
        }).row
      })
      if (['complete', 'failed', 'killed'].includes(admittedRow.state)) return
      await thinPending(project)
      await drain()
    })
    return admission.then(() => admittedRow)
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
    isBuilding,
    isBuildKindPending,
    inspect,
    store,
  }
}
