export function createBuildQueue({
  transport,
  getProjectsDir,
  relayMessage,
  recordDisposition = async () => {},
  logError = (name, e) => console.error(`[build-dispatch] worker error for ${name}: ${e.message}`),
}, options = {}) {
  // **`k >= 2` is a correctness bound, not a throughput preference** (§10.2b).
  //
  // At `k = 1` the only slot is the contested one, so a collaborator with
  // finished, buildable work never gets to run it while someone upstream keeps
  // typing and keeps reclaiming the slot on an older `waitingSince`. At `k >= 2`
  // their build runs concurrently and promotes normally, and the typist simply
  // never wins with unsettled work.
  //
  // So the DEFAULT is 2. `server.yaml` can still say otherwise — including 1,
  // which is a decision somebody is allowed to make and this does not prevent —
  // but an unset value must not silently be the starving case. It was: nothing
  // supplies a default, `buildMaxConcurrency` ships commented out, and
  // `Number(undefined || 1)` is 1.
  const configured = Number(options.maxConcurrency)
  const maxConcurrency = Number.isFinite(configured) && configured >= 1 ? configured : 2
  const buildPriority = Number.isFinite(Number(options.priority)) ? Number(options.priority) : 10
  const _inFlight = new Map() // jobKey(name, kind) -> { handle, waiters }
  const _queued = new Map()   // jobKey(name, kind) -> { name, kind, waiters }
  const _pending = new Map()  // jobKey(name, kind) -> latest queued rebuild behind the in-flight job
  let _activeCount = 0

  function jobKey(name, kind = 'build') {
    return `${name}\0${kind}`
  }

  function matchingKeys(map, name) {
    const prefix = `${name}\0`
    return [...map.keys()].filter(key => key.startsWith(prefix))
  }

  async function dispatchBuild(name, { kind = 'build', sourceRevision = null, acceptSeq = null } = {}) {
    const key = jobKey(name, kind)
    if (_inFlight.has(key)) {
      const displaced = _pending.get(key)
      if (displaced?.sourceRevision && displaced.sourceRevision !== sourceRevision) {
        await recordDisposition(displaced, 'superseded', { bySourceRevision: sourceRevision, byAcceptSeq: acceptSeq })
      }
      return new Promise((resolve, reject) => {
        const pending = _pending.get(key) || { name, kind, waiters: [] }
        pending.kind = kind
        pending.sourceRevision = sourceRevision
        pending.acceptSeq = acceptSeq
        pending.waiters.push({ resolve, reject })
        _pending.set(key, pending)
      })
    }

    if (_queued.has(key)) {
      const displaced = _queued.get(key)
      if (displaced?.sourceRevision && displaced.sourceRevision !== sourceRevision) {
        await recordDisposition(displaced, 'superseded', { bySourceRevision: sourceRevision, byAcceptSeq: acceptSeq })
      }
      return new Promise((resolve, reject) => {
      const queued = _queued.get(key)
      queued.kind = kind
      queued.sourceRevision = sourceRevision
      queued.acceptSeq = acceptSeq
        queued.waiters.push({ resolve, reject })
      })
    }

    return new Promise((resolve, reject) => {
      _enqueue({ name, kind, sourceRevision, acceptSeq, waiters: [{ resolve, reject }] })
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
    for (const waiter of waiters || []) {
      waiter.resolve()
    }
  }

  // A build that failed must reach the caller that asked for it. Cancellation
  // is not failure and still resolves — killBuild is somebody deliberately
  // stopping a build, and turning that into a rejection nobody catches would
  // take down the server on a routine action.
  function _rejectWaiters(waiters, error) {
    for (const waiter of waiters || []) {
      waiter.reject(error)
    }
  }

  function _runWorker(job) {
    const { name, kind } = job
    const key = jobKey(name, kind)
    let relays = Promise.resolve()
    // The worker's own verdict on the build. It sends `{t: 'done', ok, error}`
    // as its last act; nothing used to read it, so a build that threw resolved
    // its waiters exactly like one that succeeded and dispatchBuild() never
    // rejected for any failure at all. Every caller's .catch() was dead code —
    // including the one in the push route that sets buildStatus: 'error'. A qmd
    // render that died on a missing R package left buildStatus 'none', no
    // build.log, and nothing in the server log.
    let workerFailure = null
    // Closure state, not a field on the _inFlight entry: killAllDispatchedBuilds
    // clears that map before the workers have exited, so an entry read from it
    // in onExit is already gone.
    let cancelled = false
    function relay(msg, channel) {
      if (msg?.t === 'done' && msg.ok === false) {
        workerFailure = new Error(msg.error || `build worker for ${name} failed`)
      }
      // IPC preserves message order; serialize server effects as well so a
      // sentinel write completes before the reload that follows it.
      relays = relays.then(async () => {
        if (msg?.t === 'rpc') {
          try {
            const result = await relayMessage?.(name, msg)
            channel?.send?.({ t: 'rpc-result', id: msg.id, ok: true, result })
          } catch (e) {
            channel?.send?.({ t: 'rpc-result', id: msg.id, ok: false, error: e?.message || String(e) })
          }
          return
        }
        await relayMessage?.(name, msg)
      }).catch((e) => logError(name, e))
    }
    function onError(e) { logError(name, e) }

    async function onExit(code) {
      await relays
      _activeCount = Math.max(0, _activeCount - 1)
      _inFlight.delete(key)

      // A worker that dies without reporting — OOM, a segfault in a native
      // module, an uncaught throw outside the handler — is a failed build too,
      // and it is the case with the least evidence anywhere else. Killed
      // workers exit on a signal with a null code, and a cancelled build is
      // deliberate rather than failed, so neither becomes a rejection.
      if (!workerFailure && !cancelled && code) {
        workerFailure = new Error(`build worker for ${name} exited with code ${code}`)
      }

      if (job.sourceRevision) {
        try {
          await recordDisposition(
            job,
            cancelled ? 'cancelled' : (workerFailure ? 'build_failed' : 'built'),
            workerFailure ? { error: workerFailure.message, exitCode: code } : { exitCode: code },
          )
        } catch (error) {
          workerFailure ||= new Error(`build disposition persistence failed: ${error?.message || error}`)
          logError(name, workerFailure)
        }
      }

      if (_pending.has(key)) {
        // A rebuild is already queued behind this one, so these waiters are
        // waiting on that build's outcome now, not this one's. Carry them
        // forward whether or not this attempt failed.
        const pending = _pending.get(key)
        _pending.delete(key)
        pending.waiters = [...(job.waiters || []), ...(pending.waiters || [])]
        _queued.set(key, pending)
      } else if (workerFailure) {
        _rejectWaiters(job.waiters, workerFailure)
      } else {
        _resolveWaiters(job.waiters)
      }

      _drainQueue()
    }

    _activeCount++
    const handle = transport.start(
      {
        name,
        kind,
        sourceRevision: job.sourceRevision,
        acceptSeq: job.acceptSeq,
        projectsDir: getProjectsDir(),
        priority: buildPriority,
      },
      { onMessage: relay, onError, onExit },
    )
    _inFlight.set(key, {
      handle,
      waiters: job.waiters,
      // Cancelling goes through here so the worker's exit is known to be
      // deliberate. Reaching past it to handle.cancel() makes a killed build
      // look like a crashed one.
      cancel() { cancelled = true; handle.cancel() },
    })
  }

  async function killBuild(name) {
    for (const key of matchingKeys(_queued, name)) {
      const queued = _queued.get(key)
      _queued.delete(key)
      if (queued?.sourceRevision) await recordDisposition(queued, 'cancelled', { queued: true })
      _resolveWaiters(queued.waiters)
    }
    for (const key of matchingKeys(_pending, name)) {
      const pending = _pending.get(key)
      if (pending?.sourceRevision) await recordDisposition(pending, 'cancelled', { pending: true })
      if (pending) _resolveWaiters(pending.waiters)
      _pending.delete(key)
    }
    for (const key of matchingKeys(_inFlight, name)) {
      _inFlight.get(key)?.cancel()
    }
  }

  async function killAllDispatchedBuilds() {
    for (const queued of _queued.values()) {
      if (queued.sourceRevision) await recordDisposition(queued, 'cancelled', { queued: true })
      _resolveWaiters(queued.waiters)
    }
    for (const pending of _pending.values()) {
      if (pending.sourceRevision) await recordDisposition(pending, 'cancelled', { pending: true })
      _resolveWaiters(pending.waiters)
    }
    for (const running of _inFlight.values()) running.cancel()
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

  function isBuildKindPending(name, kind = 'build') {
    const key = jobKey(name, kind)
    return _inFlight.has(key) || _queued.has(key) || _pending.has(key)
  }

  return { dispatchBuild, killBuild, killAllDispatchedBuilds, isBuilding, isBuildKindPending }
}
