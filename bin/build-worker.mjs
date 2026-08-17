#!/usr/bin/env node
// Forked by the server (server/lib/build-dispatch.mjs) to run one build OFF the
// server's event loop. The pipeline's synchronous fs/hashing happens here, in
// this process, so it can't stall fleet chat / the WebSocket / the canvas.
//
// All the build's server-facing side-effects (client broadcasts, project.json
// writes) are shipped back to the parent over IPC, which performs them in the
// server process where the live rooms actually are. See setBuildReporter.

import { runBuild, finalizeBuildVersion, setBuildReporter } from '../server/lib/build-runner.mjs'
import { initProjectStore, readProject, projectDir } from '../server/lib/project-store.mjs'
import { buildMarkdown, buildHtml, buildSlides, buildQmd } from '../server/lib/format-builders.mjs'
import { buildProjectPartsView } from '../server/lib/project-parts-build.mjs'
import { missingDeclaredMainFile, missingMainFileMessage } from '../server/lib/build-decision.mjs'
import { setPriority, constants as osConstants } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

// Route side-effects back to the parent. Chatty/progress effects are queued
// reports. Finalizer-critical effects return acknowledged RPC promises so the
// build can own completion across the worker/server boundary.
setBuildReporter({
  broadcastSignal: (room, signal, payload) => sendReport('broadcastSignal', [room, signal, payload]),
  putShape:        (docName, shape)        => sendReport('putShape',        [docName, shape]),
  patchShape:      (docName, shapeId, propsPatch) => sendReport('patchShape', [docName, shapeId, propsPatch]),
  writeSentinel:   (docName, propsPatch)   => callParent('writeSentinel',   [docName, propsPatch]),
  emitGlobalEvent: (type, payload)         => sendReport('emitGlobalEvent', [type, payload]),
  // Deliberately fire-and-forget, and it must stay that way until the relay
  // chain is bounded. Making it an acknowledged RPC on 2026-08-17 looked right
  // -- the terminal write of buildStatus/lastBuild/lastBuildSuccess raced the
  // worker's exit and was being lost -- but the parent serializes every relay
  // through one promise chain, and mirrorShadow awaits a sender chosen to retry
  // rather than time out. So one unreachable daemon already wedged a finalize;
  // awaiting here made the FIRST statement of every subsequent build wait on
  // that same blocked chain, and builds stopped starting at all: worker alive,
  // ~3s CPU, not one line in build.log. Bounding callParent and the mirror
  // fan-out is the fix; until then a lost status write is far cheaper than a
  // build that never begins.
  updateProject:   (name, patch)           => sendReport('updateProject',   [name, patch]),
  mirrorShadow:    (name, hash, sourceRevision, acceptSeq) => callParent('mirrorShadow', [name, hash, sourceRevision, acceptSeq]),
  recordRevisionPhase: (name, sourceRevision, phase, state, result) => callParent('recordRevisionPhase', [name, sourceRevision, phase, state, result]),
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
  try {
    // This process has its own project-store module instance — point it at the
    // same projects dir the server uses, or path resolution (sourceDir/outputDir)
    // would be null.
    if (msg.projectsDir) await initProjectStore(msg.projectsDir)
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
        sendReport('updateProject', [msg.name, { buildStatus: 'error' }])
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
    await callParent('recordBuildResult', [msg.name, msg.sourceRevision, msg.acceptSeq, 'built', { ok: true }])
    process.send?.({ t: 'done', ok: true })
    process.exit(0)
  } catch (e) {
    try {
      await callParent('recordBuildResult', [msg.name, msg.sourceRevision, msg.acceptSeq, 'build_failed', { ok: false, error: e?.message || String(e) }])
    } catch (recordError) {
      e.message = `${e?.message || String(e)}; build disposition persistence failed: ${recordError?.message || recordError}`
    }
    process.send?.({ t: 'done', ok: false, error: e?.message || String(e) })
    process.exit(1)
  }
})

// If the parent goes away, don't linger.
process.on('disconnect', () => process.exit(0))
