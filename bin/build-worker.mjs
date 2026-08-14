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

function callParent(method, args) {
  if (!process.send) return Promise.reject(new Error(`build worker IPC unavailable for ${method}`))
  const id = nextRpcId++
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject })
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
