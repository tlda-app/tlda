#!/usr/bin/env node
// Forked by the server (server/lib/build-dispatch.mjs) to run one build OFF the
// server's event loop. The pipeline's synchronous fs/hashing happens here, in
// this process, so it can't stall fleet chat / the WebSocket / the canvas.
//
// All the build's server-facing side-effects (client broadcasts, project.json
// writes) are shipped back to the parent over IPC, which performs them in the
// server process where the live rooms actually are. See setBuildReporter.

import { getBuildReporter, setBuildReporter, setBuildOutputSink } from '../server/lib/build-runner.mjs'
import { initProjectStore, readProject, projectDir, sourceLifecycleStore, setProjectPathOverride } from '../server/lib/project-store.mjs'
import { buildDocument } from '../server/lib/build-document.mjs'
import { buildProjectPartsView } from '../server/lib/project-parts-build.mjs'
import { missingDeclaredMainFile, missingMainFileMessage, shouldBuildOnPush } from '../server/lib/build-decision.mjs'
import { setPriority, constants as osConstants } from 'node:os'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeBuildInstance } from '../server/lib/build-instance.mjs'

const BUILD_PRIORITY = Number(process.env.TLDA_BUILD_PRIORITY ?? 10)
const BUILD_HEARTBEAT_MS = Number(process.env.TLDA_BUILD_HEARTBEAT_MS) || 15_000
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

// Output goes out IMMEDIATELY -- `sendReport`, not `stageReport`.
//
// Everything above is staged and shipped in one lump when the build publishes,
// which is right for shape writes and project patches: they must not land
// before the build they describe. Output is the opposite. Its entire value is
// arriving while the build runs, and staging it would reproduce exactly the
// silence this exists to end.
//
// `sendReport` has been defined in this file and called from nowhere. The
// receiving side discards `t: 'report'` too, so this wire was severed at both
// ends -- see the handler in build-dispatch.mjs, which now keeps it.
setBuildOutputSink((name, line, skipped) => sendReport('buildOutput', [name, line, skipped]))

/**
 * Whether this revision's changes reach anything the render reads.
 *
 * The two revisions diffed are the project's PUBLISHED HEAD and the revision
 * being built: the head is what is on screen now, the revision is what this
 * build would land, so their difference is exactly the source change in
 * question. A project with no head yet takes `diffRevisions`' `--root` path and
 * reports every file as changed, which renders — correct for a first build.
 *
 * Deletions count as changes. Removing a file the render reads has to render.
 *
 * Errs toward rendering in every uncertain case, including its own failure:
 * an extra render costs time, a missed one silently serves a stale document and
 * reports success.
 */
async function renderRelevance(msg, lifecycle) {
  try {
    const project = await readProject(msg.name)
    const git = await lifecycle.gitRepository()
    const publishedHead = await git.head(msg.name)
    const { changed, deleted } = await git.diffRevisions(publishedHead, msg.sourceRevision)
    const changedFiles = [...changed, ...deleted]
    const decision = shouldBuildOnPush(project, msg.name, {
      changedFiles,
      anyChanged: changedFiles.length > 0,
    })
    // Gated on the REASON, not on `decision.build`. `shouldBuildOnPush` answers
    // several questions and only this one is settled here; keying on the boolean
    // would silently adopt any suppression the function grows later, and two of
    // the verdicts it already returns must not suppress a render.
    return { skip: decision.build === false && decision.reason === 'outside-tree', reason: decision.reason, changedFiles }
  } catch (e) {
    // Loud on purpose. Erring toward rendering is right, but a filter that
    // silently errs toward rendering on EVERY build is indistinguishable from a
    // filter nobody wired in — which is the state this whole change is fixing.
    console.warn(`[build-worker] ${msg.name}: could not decide render relevance, rendering: ${e.message}`)
    return { skip: false, reason: `relevance-unavailable: ${e.message}` }
  }
}

process.on('message', async (msg) => {
  if (msg?.t === 'rpc-result') {
    const pending = pendingRpc.get(msg.id)
    if (!pending) return
    pendingRpc.delete(msg.id)
    if (msg.ok) pending.resolve(msg.result)
    else {
      const error = new Error(msg.error || 'worker RPC failed')
      error.remoteStack = msg.errorStack || null
      pending.reject(error)
    }
    return
  }
  if (msg?.t !== 'build') return
  let instanceRoot = null
  const heartbeat = BUILD_HEARTBEAT_MS > 0
    ? setInterval(() => process.send?.({ t: 'heartbeat' }), BUILD_HEARTBEAT_MS)
    : null
  heartbeat?.unref?.()
  // Declared out here so the catch can reach it: the log that explains a
  // failure lives in the instance, and the instance is removed in `finally`.
  let instanceProject = null
  try {
    // This process has its own project-store module instance — point it at the
    // same projects dir the server uses, or path resolution (sourceDir/outputDir)
    // would be null.
    if (msg.projectsDir) await initProjectStore(msg.projectsDir)
    if (!msg.sourceRevision) throw new Error(`build worker for ${msg.name} requires an immutable source revision`)
    const lifecycle = await sourceLifecycleStore(msg.name)
    const liveProject = projectDir(msg.name)
    const acceptedProject = await readProject(msg.name)
    // BEFORE `setProjectPathOverride` below, and that ordering is the whole
    // reason this sits up here rather than beside the render it governs:
    // `shouldBuildOnPush` reads `relevant-files.json` out of `outputDir(name)`,
    // and once the override points at the instance that resolves to the
    // instance's freshly-created empty `output/`. The verdict would then be
    // `no-relevant-files-yet` on every build forever — a filter that always
    // says yes, which is indistinguishable from the filter not being wired in.
    const relevance = msg.kind === 'parts' ? null : await renderRelevance(msg, lifecycle)
    const instance = await materializeBuildInstance({
      name: msg.name,
      sourceRevision: msg.sourceRevision,
      lifecycle,
      seedProject: liveProject,
      seedOutput: acceptedProject?.format === 'qmd',
      materializeLinks: acceptedProject?.format === 'qmd',
    })
    instanceRoot = instance.root
    instanceProject = instance.project
    // Say what the silent half of the build just spent. Without this the gap
    // between "revision accepted" and the first Quarto line is unexplained
    // minutes, and a build doing invisible work is indistinguishable from one
    // that has stalled. Printed even when fast, so the number is a baseline
    // rather than an alarm.
    if (instance.timings) {
      const t = instance.timings
      console.log(
        `[build-worker] ${msg.name}: instance ready in ${t.totalMs}ms `
        + `(seed-output ${t.seedOutputMs}ms, caches ${t.seedCachesMs}ms, `
        + `source ${t.writeSourceMs}ms`
        + (t.materializedLinks ? ', links materialized' : `, ${t.sourceFiles} files / ${Math.round(t.sourceBytes / 1024)}KB`)
        + ')',
      )
    }
    setProjectPathOverride(msg.name, instanceProject)
    if (msg.kind === 'parts') {
      await buildProjectPartsView(msg.name)
    } else {
      const project = await readProject(msg.name)

      // Before any format is chosen and before anything renders. A project that
      // declares a main file which is not there has no document to build, and
      // every builder below would otherwise go looking for something else to
      // render: `buildSlidesDocument` takes the first .html it finds, runBuild derives a
      // texBase from a path that does not exist. That is how a Quarto talk
      // declaring `main.tex` built "successfully" for four days.
      const missingMain = missingDeclaredMainFile(project, msg.name)
      if (missingMain) {
        const message = missingMainFileMessage(msg.name, missingMain)
        // build.log before the throw, and synchronously: it is the only copy of
        // this. `t: 'done', ok: false` is not relayed to any sink, and the
        // report below is fire-and-forget IPC racing process.exit. The file is
        // what `tlda project status` prints.
        //
        // NOTE: `projectDir` here is the INSTANCE, because the path override is
        // set above — so this write did not survive the worker at all until the
        // catch below started carrying diagnostics out. The comment used to say
        // it outlived the worker; it did not, and the file died with the
        // instance along with every other failed build's log.
        writeFileSync(join(projectDir(msg.name), 'build.log'), `[build] ${message}\n`)
        await callParent('updateProject', [msg.name, { buildStatus: 'error', pages: 0 }])
        throw new Error(message)
      }

      // THE DISPATCH IS GONE. Every format now goes through `buildDocument()`,
      // which picks the adapter from the project's three axes and owns the
      // completion tail. What used to be here was a map from `project.format`
      // to a builder, plus a fall-through to `runBuild` for everything else.
      //
      // What did NOT move, and must not: everything AROUND this call. The
      // relevance skip below, `replacedItems`, the `not_required` disposition,
      // the missing-main check above, and the three failure tails in the catch
      // all landed on `main` after the RC branch and are absent from it.
      // Swapping this block out carelessly is how all of them get deleted
      // without anyone noticing, because each fails by simply not happening.
      // `bin/cutover-contract-controls.mjs` exists to catch exactly that and
      // counts each one against the real worker.
      //
      // Versioning moved INTO the boundary rather than being dropped: it used
      // to be this branch's `finalizeBuildVersion` for non-LaTeX formats, while
      // LaTeX reached it inside `runBuild`. `buildDocument` versions the
      // adapters that do not version themselves, and skips the two LaTeX ones
      // that do -- so it stays exactly one version per build either way.
      if (relevance?.skip) {
        // Nothing this revision changed is read by the render, so the render is
        // skipped and the revision still lands: `['source']` below advances the
        // source and the head while the last good render stays published.
        // Skipping the ADMISSION instead would strand the push — the head only
        // ever moves inside publishBuildInstance.
        console.log(`[build-worker] ${msg.name}: ${msg.sourceRevision.slice(0, 12)} is ${relevance.reason}, publishing source without rendering`)
      } else {
        await buildDocument(project, {
          name: msg.name,
          sourceRevision: msg.sourceRevision,
          acceptSeq: msg.acceptSeq,
          changedFiles: relevance?.changedFiles,
          reporter: getBuildReporter(),
          log: console.log,
        })
      }
    }
    const replacedItems = relevance?.skip ? ['source'] : null
    await callParent('publishBuildInstance', [msg.name, msg.sourceRevision, msg.acceptSeq, instanceProject, stagedReports, replacedItems])
    await callParent('recordBuildResult', [msg.name, msg.sourceRevision, msg.acceptSeq, relevance?.skip ? 'not_required' : 'built', { ok: true }])
    process.send?.({ t: 'done', ok: true })
    setImmediate(() => process.exit(0))
  } catch (e) {
    // Before anything else in this handler, and before `finally` removes the
    // instance: the log is the only account of why this failed, and it exists
    // nowhere but inside the instance. Diagnostics only — no artifacts cross,
    // so the last good render stays the published one.
    // Unconditional, and that is the point: `instanceProject` is still null for
    // every failure that happens before the instance is materialized — a
    // missing source revision, an unopenable lifecycle store, the
    // materialization itself. Gated on the instance, those failures wrote no
    // log anywhere and `tlda project errors` reported the absence as a defect
    // with nothing to point at. The reason is passed so there is always
    // something to write when there was nothing to carry out.
    try {
      const reason = e?.message || String(e)
      const stack = e?.remoteStack || e?.stack
      const diagnostic = stack ? `${reason}\n${stack}` : reason
      await callParent('publishBuildDiagnostics', [msg.name, instanceProject, diagnostic])
    } catch (diagError) {
      // Never let saving the explanation replace the failure being explained.
      console.error(`[build-worker] could not preserve diagnostics for ${msg.name}: ${diagError?.message || diagError}`)
    }
    try {
      await callParent('reportBuildFailure', [msg.name, e?.message || String(e), msg.sourceRevision, msg.acceptSeq])
    } catch (reportError) {
      e.message = `${e?.message || String(e)}; build failure delivery failed: ${reportError?.message || reportError}`
    }
    try {
      await callParent('recordBuildResult', [msg.name, msg.sourceRevision, msg.acceptSeq, 'build_failed', { ok: false, error: e?.message || String(e) }])
    } catch (recordError) {
      e.message = `${e?.message || String(e)}; build disposition persistence failed: ${recordError?.message || recordError}`
    }
    process.send?.({
      t: 'done', ok: false,
      error: e?.message || String(e),
      errorStack: e?.remoteStack || e?.stack || null,
    })
    setImmediate(() => process.exit(1))
  } finally {
    if (heartbeat) clearInterval(heartbeat)
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
