#!/usr/bin/env node
// Forked by the server (server/lib/build-dispatch.mjs) to run one build OFF the
// server's event loop. The pipeline's synchronous fs/hashing happens here, in
// this process, so it can't stall fleet chat / the WebSocket / the canvas.
//
// All the build's server-facing side-effects (client broadcasts, project.json
// writes) are shipped back to the parent over IPC, which performs them in the
// server process where the live rooms actually are. See setBuildReporter.

import { runBuild, setBuildReporter } from '../server/lib/build-runner.mjs'
import { initProjectStore } from '../server/lib/project-store.mjs'

// Route every side-effect back to the parent. Ordered IPC (process.send) keeps
// the sentinel-then-reload ordering the pipeline relies on.
setBuildReporter({
  broadcastSignal: (room, signal, payload) => process.send?.({ t: 'report', m: 'broadcastSignal', a: [room, signal, payload] }),
  putShape:        (docName, shape)        => process.send?.({ t: 'report', m: 'putShape',        a: [docName, shape] }),
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
    await runBuild(msg.name, { priorityPages: msg.priorityPages })
    process.send?.({ t: 'done', ok: true })
    process.exit(0)
  } catch (e) {
    process.send?.({ t: 'done', ok: false, error: e?.message || String(e) })
    process.exit(1)
  }
})

// If the parent goes away, don't linger.
process.on('disconnect', () => process.exit(0))
