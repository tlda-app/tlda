#!/usr/bin/env node
// Forked by the server (server/lib/build-dispatch.mjs) to run one build OFF the
// server's event loop. The pipeline's synchronous fs/hashing happens here, in
// this process, so it can't stall fleet chat / the WebSocket / the canvas.
//
// All the build's server-facing side-effects (client broadcasts, project.json
// writes) are shipped back to the parent over IPC, which performs them in the
// server process where the live rooms actually are. See setBuildReporter.

import { runBuild, setBuildReporter } from '../server/lib/build-runner.mjs'
import { initProjectStore, readProject } from '../server/lib/project-store.mjs'
import { buildMarkdown, buildHtml, buildSlides } from '../server/lib/format-builders.mjs'
import { buildProjectPartsView } from '../server/lib/project-parts-build.mjs'
import { setPriority, constants as osConstants } from 'node:os'

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

// Route every side-effect back to the parent. Ordered IPC (process.send) keeps
// the sentinel-then-reload ordering the pipeline relies on.
setBuildReporter({
  broadcastSignal: (room, signal, payload) => process.send?.({ t: 'report', m: 'broadcastSignal', a: [room, signal, payload] }),
  putShape:        (docName, shape)        => process.send?.({ t: 'report', m: 'putShape',        a: [docName, shape] }),
  patchShape:      (docName, shapeId, propsPatch) => process.send?.({ t: 'report', m: 'patchShape', a: [docName, shapeId, propsPatch] }),
  writeSentinel:   (docName, propsPatch)   => process.send?.({ t: 'report', m: 'writeSentinel',   a: [docName, propsPatch] }),
  emitGlobalEvent: (type, payload)         => process.send?.({ t: 'report', m: 'emitGlobalEvent', a: [type, payload] }),
  updateProject:   (name, patch)           => process.send?.({ t: 'report', m: 'updateProject',   a: [name, patch] }),
})

process.on('message', async (msg) => {
  if (msg?.t !== 'build') return
  try {
    // This process has its own project-store module instance — point it at the
    // same projects dir the server uses, or path resolution (sourceDir/outputDir)
    // would be null.
    if (msg.projectsDir) initProjectStore(msg.projectsDir)
    if (msg.kind === 'parts') {
      await buildProjectPartsView(msg.name)
    } else {
      const builder = { markdown: buildMarkdown, html: buildHtml, slides: buildSlides }[readProject(msg.name)?.format]
      if (builder) await builder(msg.name)
      else await runBuild(msg.name, { priorityPages: msg.priorityPages })
    }
    process.send?.({ t: 'done', ok: true })
    process.exit(0)
  } catch (e) {
    process.send?.({ t: 'done', ok: false, error: e?.message || String(e) })
    process.exit(1)
  }
})

// If the parent goes away, don't linger.
process.on('disconnect', () => process.exit(0))
