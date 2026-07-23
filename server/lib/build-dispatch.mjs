// Server-side build dispatcher. Replaces the inline `await runBuild(...)` calls.
// The server NEVER runs the build itself — it delegates to a BuildTransport (off
// the event loop), relays the worker's side-effects to the live rooms, and
// coalesces/serializes per project so rapid saves collapse to one build.

import { broadcastSignal, putShape, updateShape, emitGlobalEvent, getLastSignal } from './sync-rooms.mjs'
import { updateProject, getProjectsDir } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'
import { loadServerConfig } from '../../shared/config.mjs'
import { ForkTransport } from './build-transport.mjs'
import { createBuildQueue } from './build-queue.mjs'
import { mirrorShadow } from './build-runner.mjs'

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

const SINKS = { broadcastSignal, putShape, patchShape, writeSentinel, emitGlobalEvent, updateProject, mirrorShadow }

/**
 * Create a bound dispatcher instance. Transport is injected so the coalescing
 * logic is independently testable with a fake transport. Production callers use
 * the module-level exports which bind the configured transport at load time.
 */
export function createDispatcher(transport) {
  return createDispatcherWithOptions(transport)
}

export function createDispatcherWithOptions(transport, options = {}) {
  const sinks = options.sinks || SINKS
  const queue = createBuildQueue({
    transport,
    getProjectsDir,
    relayMessage(name, msg) {
      if (msg?.t === 'report') {
        return Promise.resolve()
          .then(() => sinks[msg.m]?.(...(msg.a || [])))
          .catch((e) => {
          // One side-effect failure must not hide worker exit/completion from waiters.
          console.error(`[build-dispatch] relay ${msg.m} for ${name} failed: ${e.message}`)
          })
      }
      if (msg?.t === 'rpc') {
        const sink = sinks[msg.m]
        if (!sink) throw new Error(`unknown build worker RPC: ${msg.m}`)
        return Promise.resolve().then(() => sink(...(msg.a || [])))
      }
    },
  }, options)

  async function dispatchBuild(name, { priorityPages, kind = 'build' } = {}) {
    // Resolve the camera/viewport priority HERE (the worker has no live rooms),
    // so the worker never needs a round-trip back for it.
    if (!priorityPages || priorityPages.length === 0) {
      try {
        const vp = getLastSignal(`doc-${name}`, 'signal:viewport')
        if (vp?.pages?.length > 0) priorityPages = vp.pages
      } catch { priorityPages = priorityPages || undefined } // no viewport signal yet → no priority
    }

    return queue.dispatchBuild(name, { priorityPages, kind })
  }

  return { ...queue, dispatchBuild }
}

// The server always forks the local worker. Only real queue settings remain
// configurable in server.yaml.
const _config = loadServerConfig()
const _default = createDispatcherWithOptions(ForkTransport, {
  maxConcurrency: _config.buildMaxConcurrency,
  priority: _config.buildPriority,
})

export const { dispatchBuild, killBuild, killAllDispatchedBuilds, isBuilding, isBuildKindPending } = _default
