// Server-side build dispatcher. Replaces the inline `await runBuild(...)` calls.
// The server NEVER runs the build itself — it delegates to a BuildTransport (off
// the event loop), relays the worker's side-effects to the live rooms, and
// coalesces/serializes per project so rapid saves collapse to one build.

import { broadcastSignal, putShape, updateShape, emitGlobalEvent, getLastSignal } from './sync-rooms.mjs'
import { updateProject, getProjectsDir } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'
import { loadConfig } from '../../shared/config.mjs'
import { makeTransport } from './build-transport.mjs'

// The real server-side side-effect functions, keyed the way the worker reports
// them. A build that runs in the worker calls these here, in the server process.
async function patchShape(docName, shapeId, propsPatch) {
  try {
    await updateShape(docName, shapeId, (cur) => ({
      ...cur,
      props: { ...(cur.props || {}), ...(propsPatch || {}) },
    }))
  } catch (e) {
    if (!/not found/i.test(e?.message || '')) throw e
    await putShape(docName, {
      id: shapeId,
      typeName: 'shape',
      type: 'doc-version',
      x: 0,
      y: 0,
      rotation: 0,
      index: 'a0',
      parentId: 'page:page',
      isLocked: true,
      opacity: 0,
      meta: {},
      props: {
        w: 1,
        h: 1,
        commitHash: 'unknown',
        timestamp: Date.now(),
        buildReadyAt: Date.now(),
        warningsJson: '',
        errorsJson: '',
        ...(propsPatch || {}),
      },
    })
  }
}

const SINKS = { broadcastSignal, putShape, patchShape, writeSentinel, emitGlobalEvent, updateProject }

/**
 * Create a bound dispatcher instance. Transport is injected so the coalescing
 * logic is independently testable with a fake transport. Production callers use
 * the module-level exports which bind the configured transport at load time.
 */
export function createDispatcher(transport) {
  const _inFlight = new Map() // name -> transport handle { cancel() }
  const _pending = new Map()  // name -> latest priorityPages waiting behind the in-flight build

  /**
   * Dispatch a build for `name`. Resolves when the build (and any build that
   * coalesced behind it) completes. The heavy work runs via the configured transport.
   */
  async function dispatchBuild(name, { priorityPages } = {}) {
    // Resolve the camera/viewport priority HERE (the worker has no live rooms),
    // so the worker never needs a round-trip back for it.
    if (!priorityPages || priorityPages.length === 0) {
      try {
        const vp = getLastSignal(`doc-${name}`, 'signal:viewport')
        if (vp?.pages?.length > 0) priorityPages = vp.pages
      } catch { priorityPages = priorityPages || undefined } // no viewport signal yet → no priority
    }

    // Coalesce: a build is already running for this doc — record the latest
    // priority pages and let the in-flight build's completion drain it.
    if (_inFlight.has(name)) {
      _pending.set(name, priorityPages || null)
      return
    }
    return _runWorker(name, priorityPages)
  }

  function _runWorker(name, priorityPages) {
    return new Promise((resolve) => {
      function relay(msg) {
        if (msg?.t === 'report') {
          try { SINKS[msg.m]?.(...(msg.a || [])) }
          catch (e) { console.error(`[build-dispatch] relay ${msg.m} for ${name} failed: ${e.message}`) }
        }
      }

      function logErr(e) {
        console.error(`[build-dispatch] worker error for ${name}: ${e.message}`)
      }

      function drainCoalesced(_code) {
        _inFlight.delete(name)
        resolve()
        // Drain a coalesced rebuild, if one queued up while this ran.
        if (_pending.has(name)) {
          const pp = _pending.get(name)
          _pending.delete(name)
          _runWorker(name, pp)
        }
      }

      const handle = transport.start(
        { name, priorityPages, projectsDir: getProjectsDir() },
        { onMessage: relay, onError: logErr, onExit: drainCoalesced }
      )
      _inFlight.set(name, handle)
    })
  }

  /** Cancel the in-flight build for a doc — killing the worker kills its children. */
  function killBuild(name) {
    const handle = _inFlight.get(name)
    if (handle) handle.cancel()
    _pending.delete(name)
  }

  /** Kill every in-flight build worker (server shutdown). */
  function killAllDispatchedBuilds() {
    for (const handle of _inFlight.values()) handle.cancel()
    _inFlight.clear()
    _pending.clear()
  }

  function isBuilding(name) { return _inFlight.has(name) }

  return { dispatchBuild, killBuild, killAllDispatchedBuilds, isBuilding }
}

// Select the transport once at server start — no per-call branching.
const _default = createDispatcher(makeTransport(loadConfig()))

export const { dispatchBuild, killBuild, killAllDispatchedBuilds, isBuilding } = _default
