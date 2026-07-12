export function createBuildQueue({
  transport,
  getProjectsDir,
  relayMessage,
  logError = (name, e) => console.error(`[build-dispatch] worker error for ${name}: ${e.message}`),
}, options = {}) {
  const maxConcurrency = Math.max(1, Number(options.maxConcurrency || 1) || 1)
  const buildPriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 10
  const _inFlight = new Map() // jobKey(name, kind) -> { handle, waiters }
  const _queued = new Map()   // jobKey(name, kind) -> { name, kind, priorityPages, waiters }
  const _pending = new Map()  // jobKey(name, kind) -> latest queued rebuild behind the in-flight job
  let _activeCount = 0

  function jobKey(name, kind = 'build') {
    return `${name}\0${kind}`
  }

  function matchingKeys(map, name) {
    const prefix = `${name}\0`
    return [...map.keys()].filter(key => key.startsWith(prefix))
  }

  async function dispatchBuild(name, { priorityPages, kind = 'build' } = {}) {
    const key = jobKey(name, kind)
    if (_inFlight.has(key)) {
      return new Promise((resolve) => {
        const pending = _pending.get(key) || { name, priorityPages: null, kind, waiters: [] }
        pending.priorityPages = priorityPages || null
        pending.kind = kind
        pending.waiters.push(resolve)
        _pending.set(key, pending)
      })
    }

    if (_queued.has(key)) {
      return new Promise((resolve) => {
        const queued = _queued.get(key)
        queued.priorityPages = priorityPages || null
        queued.kind = kind
        queued.waiters.push(resolve)
      })
    }

    return new Promise((resolve) => {
      _enqueue({ name, priorityPages, kind, waiters: [resolve] })
    })
  }

  function _enqueue(job) {
    if (_activeCount < maxConcurrency) {
      _runWorker(job)
    } else {
      _queued.set(jobKey(job.name, job.kind), job)
    }
  }

  function _drainQueue() {
    while (_activeCount < maxConcurrency && _queued.size > 0) {
      const [key, job] = _queued.entries().next().value
      _queued.delete(key)
      _runWorker(job)
    }
  }

  function _resolveWaiters(waiters) {
    for (const resolve of waiters || []) {
      resolve()
    }
  }

  function _runWorker(job) {
    const { name, priorityPages, kind } = job
    const key = jobKey(name, kind)
    let relays = Promise.resolve()
    function relay(msg) {
      // IPC preserves message order; serialize server effects as well so a
      // sentinel write completes before the reload that follows it.
      relays = relays.then(() => relayMessage?.(name, msg)).catch((e) => logError(name, e))
    }
    function onError(e) { logError(name, e) }

    async function onExit(_code) {
      await relays
      _activeCount = Math.max(0, _activeCount - 1)
      _inFlight.delete(key)

      if (_pending.has(key)) {
        const pending = _pending.get(key)
        _pending.delete(key)
        pending.waiters = [...(job.waiters || []), ...(pending.waiters || [])]
        _queued.set(key, pending)
      } else {
        _resolveWaiters(job.waiters)
      }

      _drainQueue()
    }

    _activeCount++
    const handle = transport.start(
      { name, priorityPages, kind, projectsDir: getProjectsDir(), priority: buildPriority },
      { onMessage: relay, onError, onExit },
    )
    _inFlight.set(key, { handle, waiters: job.waiters })
  }

  function killBuild(name) {
    for (const key of matchingKeys(_queued, name)) {
      const queued = _queued.get(key)
      _queued.delete(key)
      _resolveWaiters(queued.waiters)
    }
    for (const key of matchingKeys(_pending, name)) {
      const pending = _pending.get(key)
      if (pending) _resolveWaiters(pending.waiters)
      _pending.delete(key)
    }
    for (const key of matchingKeys(_inFlight, name)) {
      _inFlight.get(key)?.handle.cancel()
    }
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

  function isBuilding(name) {
    return matchingKeys(_inFlight, name).length > 0 ||
      matchingKeys(_queued, name).length > 0 ||
      matchingKeys(_pending, name).length > 0
  }

  return { dispatchBuild, killBuild, killAllDispatchedBuilds, isBuilding }
}
