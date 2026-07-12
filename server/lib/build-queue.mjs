export function createBuildQueue({
  transport,
  getProjectsDir,
  relayMessage,
  logError = (name, e) => console.error(`[build-dispatch] worker error for ${name}: ${e.message}`),
}, options = {}) {
  const maxConcurrency = Math.max(1, Number(options.maxConcurrency || 1) || 1)
  const buildPriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 10
  const _inFlight = new Map() // name -> { handle, waiters }
  const _queued = new Map()   // name -> { name, priorityPages, waiters }
  const _pending = new Map()  // name -> latest queued rebuild behind the in-flight build
  let _activeCount = 0

  async function dispatchBuild(name, { priorityPages } = {}) {
    if (_inFlight.has(name)) {
      return new Promise((resolve) => {
        const pending = _pending.get(name) || { name, priorityPages: null, waiters: [] }
        pending.priorityPages = priorityPages || null
        pending.waiters.push(resolve)
        _pending.set(name, pending)
      })
    }

    if (_queued.has(name)) {
      return new Promise((resolve) => {
        const queued = _queued.get(name)
        queued.priorityPages = priorityPages || null
        queued.waiters.push(resolve)
      })
    }

    return new Promise((resolve) => {
      _enqueue({ name, priorityPages, waiters: [resolve] })
    })
  }

  function _enqueue(job) {
    if (_activeCount < maxConcurrency) {
      _runWorker(job)
    } else {
      _queued.set(job.name, job)
    }
  }

  function _drainQueue() {
    while (_activeCount < maxConcurrency && _queued.size > 0) {
      const [name, job] = _queued.entries().next().value
      _queued.delete(name)
      _runWorker(job)
    }
  }

  function _resolveWaiters(waiters) {
    for (const resolve of waiters || []) {
      resolve()
    }
  }

  function _runWorker(job) {
    const { name, priorityPages } = job
    function relay(msg) { relayMessage?.(name, msg) }
    function onError(e) { logError(name, e) }

    function onExit(_code) {
      _activeCount = Math.max(0, _activeCount - 1)
      _inFlight.delete(name)

      if (_pending.has(name)) {
        const pending = _pending.get(name)
        _pending.delete(name)
        pending.waiters = [...(job.waiters || []), ...(pending.waiters || [])]
        _enqueue(pending)
      } else {
        _resolveWaiters(job.waiters)
      }

      _drainQueue()
    }

    _activeCount++
    const handle = transport.start(
      { name, priorityPages, projectsDir: getProjectsDir(), priority: buildPriority },
      { onMessage: relay, onError, onExit },
    )
    _inFlight.set(name, { handle, waiters: job.waiters })
  }

  function killBuild(name) {
    const running = _inFlight.get(name)
    const queued = _queued.get(name)
    if (queued) {
      _queued.delete(name)
      _resolveWaiters(queued.waiters)
    }
    const pending = _pending.get(name)
    if (pending) _resolveWaiters(pending.waiters)
    _pending.delete(name)
    if (running) running.handle.cancel()
  }

  function killAllDispatchedBuilds() {
    for (const queued of _queued.values()) _resolveWaiters(queued.waiters)
    for (const pending of _pending.values()) _resolveWaiters(pending.waiters)
    for (const running of _inFlight.values()) running.handle.cancel()
    _inFlight.clear()
    _queued.clear()
    _pending.clear()
    _activeCount = 0
  }

  function isBuilding(name) { return _inFlight.has(name) || _queued.has(name) || _pending.has(name) }

  return { dispatchBuild, killBuild, killAllDispatchedBuilds, isBuilding }
}
