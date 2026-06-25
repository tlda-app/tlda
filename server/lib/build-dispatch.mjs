// Server-side build dispatcher. Replaces the inline `await runBuild(...)` calls.
// The server NEVER runs the build itself — it forks bin/build-worker.mjs (off
// the event loop), relays the worker's side-effects to the live rooms, and
// coalesces/serializes per project so rapid saves collapse to one build.

import { fork } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { broadcastSignal, putShape, updateShape, emitGlobalEvent, getLastSignal } from './sync-rooms.mjs'
import { updateProject, getProjectsDir } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER = join(__dirname, '..', '..', 'bin', 'build-worker.mjs')

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

const _inFlight = new Map() // name -> child process
const _pending = new Map()  // name -> latest priorityPages waiting behind the in-flight build

/**
 * Dispatch a build for `name`. Resolves when the build (and any build that
 * coalesced behind it) completes. The heavy work runs in a forked process.
 */
export async function dispatchBuild(name, { priorityPages } = {}) {
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
    let child
    try {
      child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    } catch (e) {
      console.error(`[build-dispatch] failed to fork worker for ${name}: ${e.message}`)
      resolve()
      return
    }
    _inFlight.set(name, child)

    child.on('message', (msg) => {
      if (msg?.t === 'report') {
        try { SINKS[msg.m]?.(...(msg.a || [])) }
        catch (e) { console.error(`[build-dispatch] relay ${msg.m} for ${name} failed: ${e.message}`) }
      }
    })

    child.on('error', (e) => console.error(`[build-dispatch] worker error for ${name}: ${e.message}`))

    child.on('exit', (code) => {
      _inFlight.delete(name)
      resolve()
      // Drain a coalesced rebuild, if one queued up while this ran.
      if (_pending.has(name)) {
        const pp = _pending.get(name)
        _pending.delete(name)
        _runWorker(name, pp)
      }
    })

    child.send({ t: 'build', name, priorityPages, projectsDir: getProjectsDir() })
  })
}

/** Cancel the in-flight build for a doc — killing the worker kills its children. */
export function killBuild(name) {
  const c = _inFlight.get(name)
  if (c) c.kill('SIGTERM') // no-throw if the worker already exited
  _pending.delete(name)
}

/** Kill every in-flight build worker (server shutdown). */
export function killAllDispatchedBuilds() {
  for (const c of _inFlight.values()) c.kill('SIGTERM') // no-throw if already exited
  _inFlight.clear()
  _pending.clear()
}

export function isBuilding(name) { return _inFlight.has(name) }
