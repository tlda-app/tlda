#!/usr/bin/env node
// Forked by the server (server/lib/build-dispatch.mjs) to run one build OFF the
// server's event loop. The pipeline's synchronous fs/hashing happens here, in
// this process, so it can't stall fleet chat / the WebSocket / the canvas.
//
// All the build's server-facing side-effects (client broadcasts, project.json
// writes) are shipped back to the parent over IPC, which performs them in the
// server process where the live rooms actually are. See setBuildReporter.

import { runBuild, finalizeBuildVersion, setBuildReporter } from '../server/lib/build-runner.mjs'
import { initProjectStore, readProject, projectDir, sourceLifecycleStore, setProjectPathOverride } from '../server/lib/project-store.mjs'
import { buildMarkdown, buildHtml, buildSlides, buildQmd } from '../server/lib/format-builders.mjs'
import { buildProjectPartsView } from '../server/lib/project-parts-build.mjs'
import { missingDeclaredMainFile, missingMainFileMessage } from '../server/lib/build-decision.mjs'
import { setPriority, constants as osConstants } from 'node:os'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeBuildInstance } from '../server/lib/build-instance.mjs'

const BUILD_PRIORITY = Number(process.env.TLDA_BUILD_PRIORITY ?? 10)
if (Number.isFinite(BUILD_PRIORITY)) {
  try {
    const low = osConstants.priority.PRIORITY_LOW
    const belowNormal = osConstants.priority.PRIORITY_BELOW_NORMAL
    setPriority(Math.min(low, Math.max(belowNormal, BUILD_PRIORITY)))
  } catch (e) {
    // Priority lowering is best-effort; the worker must still run when the OS denies it.
    console.warn(`[build-worker] failed to lower priority: ${e.message}`)
  }
}

let nextRpcId = 1
const pendingRpc = new Map()

function sendReport(method, args) {
  process.send?.({ t: 'report', m: method, a: args })
}

// A build must not be able to wait forever on the server. `callParent` used to
// have no deadline at all: it settled only when the parent sent `rpc-result`, and
// the parent sends that from inside a serialized relay chain, so any earlier relay
// that never settled blocked the reply too. `mirrorShadow` is such a relay — it
// awaits the durable daemon sender, which retries rather than timing out.
//
// The result was not a slow build but a permanent one. The worker never exited, so
// the queue's `onExit` never ran, so `_inFlight` kept the project and every later
// dispatch answered `already-building` → `superseded`. On 2026-08-17 that outlived
// killing the worker, restarting the daemon and restarting the server, because the
// process dying does not release a slot whose release is chained behind the same
// stalled relay. Failing loudly here is what lets the queue recover at all.
// Outermost layer of the mirror budget (see the table in unified-server.mjs).
// Must exceed MIRROR_KEY_TIMEOUT_MS, or the worker abandons a mirror the server
// is still legitimately waiting on and the build fails for the wrong reason.
const PARENT_RPC_TIMEOUT_MS = Number(process.env.TLDA_BUILD_RPC_TIMEOUT_MS) || 240000

function callParent(method, args, { timeoutMs = PARENT_RPC_TIMEOUT_MS } = {}) {
  if (!process.send) return Promise.reject(new Error(`build worker IPC unavailable for ${method}`))
  const id = nextRpcId++
  return new Promise((resolve, reject) => {
    // Not unref'd, for the same reason the mirror's deadline is not: if the hung
    // RPC is the only thing outstanding, an unref'd timer never fires and the
    // deadline does nothing. It is cleared on settle either way.
    const timer = setTimeout(() => {
      pendingRpc.delete(id)
      reject(new Error(`build worker RPC ${method} got no answer from the server within ${timeoutMs}ms`))
    }, timeoutMs)
    const settle = fn => value => { clearTimeout(timer); fn(value) }
    pendingRpc.set(id, { resolve: settle(resolve), reject: settle(reject) })
    process.send({ t: 'rpc', id, m: method, a: args })
  })
}

// A build instance stages every externally visible side effect. The parent
// applies them only after it authorizes and publishes this exact revision.
const stagedReports = []
const stageReport = (method, args) => {
  stagedReports.push({ method, args })
  return Promise.resolve(method === 'writeSentinel' ? { skipped: false } : null)
}
setBuildReporter({
  regenerateBookTocs: (name) => stageReport('regenerateBookTocs', [name]),
  broadcastSignal: (room, signal, payload) => stageReport('broadcastSignal', [room, signal, payload]),
  putShape:        (docName, shape)        => stageReport('putShape', [docName, shape]),
  patchShape:      (docName, shapeId, propsPatch) => stageReport('patchShape', [docName, shapeId, propsPatch]),
  writeSentinel:   (docName, propsPatch)   => stageReport('writeSentinel', [docName, propsPatch]),
  emitGlobalEvent: (type, payload)         => stageReport('emitGlobalEvent', [type, payload]),
  updateProject:   (name, patch)           => stageReport('updateProject', [name, patch]),
  mirrorShadow:    (name, hash, sourceRevision, acceptSeq) => stageReport('mirrorShadow', [name, hash, sourceRevision, acceptSeq]),
  recordRevisionPhase: (name, sourceRevision, phase, state, result) => stageReport('recordRevisionPhase', [name, sourceRevision, phase, state, result]),
})

process.on('message', async (msg) => {
  if (msg?.t === 'rpc-result') {
    const pending = pendingRpc.get(msg.id)
    if (!pending) return
    pendingRpc.delete(msg.id)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new Error(msg.error || 'worker RPC failed'))
    return
  }
  if (msg?.t !== 'build') return
  let instanceRoot = null
  try {
    // This process has its own project-store module instance — point it at the
    // same projects dir the server uses, or path resolution (sourceDir/outputDir)
    // would be null.
    if (msg.projectsDir) await initProjectStore(msg.projectsDir)
    if (!msg.sourceRevision) throw new Error(`build worker for ${msg.name} requires an immutable source revision`)
    const lifecycle = await sourceLifecycleStore(msg.name)
    const liveProject = projectDir(msg.name)
    const instance = await materializeBuildInstance({ name: msg.name, sourceRevision: msg.sourceRevision, lifecycle, seedProject: liveProject })
    instanceRoot = instance.root
    const instanceProject = instance.project
    setProjectPathOverride(msg.name, instanceProject)
    if (msg.kind === 'parts') {
      await buildProjectPartsView(msg.name)
    } else {
      const project = await readProject(msg.name)

      // Before any format is chosen and before anything renders. A project that
      // declares a main file which is not there has no document to build, and
      // every builder below would otherwise go looking for something else to
      // render: buildSlides takes the first .html it finds, runBuild derives a
      // texBase from a path that does not exist. That is how a Quarto talk
      // declaring `main.tex` built "successfully" for four days.
      const missingMain = missingDeclaredMainFile(project, msg.name)
      if (missingMain) {
        const message = missingMainFileMessage(msg.name, missingMain)
        // build.log before the throw, and synchronously: it is the only copy of
        // this that outlives the worker. `t: 'done', ok: false` is not relayed
        // to any sink, and the report below is fire-and-forget IPC racing
        // process.exit. The file is what `tlda project status` prints.
        writeFileSync(join(projectDir(msg.name), 'build.log'), `[build] ${message}\n`)
        await callParent('updateProject', [msg.name, { buildStatus: 'error', pages: 0 }])
        throw new Error(message)
      }

      const builder = { markdown: buildMarkdown, html: buildHtml, slides: buildSlides, qmd: buildQmd }[project?.format]
      if (builder) {
        await builder(msg.name)
        // A build happened, so it gets a version — same as LaTeX, which reaches
        // recordBuildVersion through runBuild's finalizer. Versioning used to
        // live inside the LaTeX branch, which is why these formats built for
        // months without ever recording one.
        await finalizeBuildVersion({ name: msg.name, sourceRevision: msg.sourceRevision, acceptSeq: msg.acceptSeq })
      } else {
        await runBuild(msg.name, { sourceRevision: msg.sourceRevision, acceptSeq: msg.acceptSeq })
      }
    }
    await callParent('publishBuildInstance', [msg.name, msg.sourceRevision, msg.acceptSeq, instanceProject, stagedReports])
    await callParent('recordBuildResult', [msg.name, msg.sourceRevision, msg.acceptSeq, 'built', { ok: true }])
    process.send?.({ t: 'done', ok: true })
    setImmediate(() => process.exit(0))
  } catch (e) {
    try {
      await callParent('recordBuildResult', [msg.name, msg.sourceRevision, msg.acceptSeq, 'build_failed', { ok: false, error: e?.message || String(e) }])
    } catch (recordError) {
      e.message = `${e?.message || String(e)}; build disposition persistence failed: ${recordError?.message || recordError}`
    }
    process.send?.({ t: 'done', ok: false, error: e?.message || String(e) })
    setImmediate(() => process.exit(1))
  } finally {
    if (instanceRoot) {
      setProjectPathOverride(msg.name, null)
      try {
        rmSync(instanceRoot, { recursive: true, force: true })
      } catch (cleanupError) {
        // Cleanup failure must not replace the build's already-recorded disposition.
        console.error(`[build-worker] failed to remove private instance ${instanceRoot}: ${cleanupError?.message || cleanupError}`)
      }
    }
  }
})

// If the parent goes away, don't linger.
process.on('disconnect', () => process.exit(0))
