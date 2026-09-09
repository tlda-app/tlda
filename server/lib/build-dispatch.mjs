import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
// The two recursive whole-tree operations in `publishBuildInstance` are async.
// Everything else here stays sync: `renameSync` is a metadata operation on one
// filesystem and costs nothing, and turning it async would put yields inside
// the swap, which is the one part that must not be interleaved.
import { cp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { broadcastSignal, putShape, updateShape, emitGlobalEvent } from './sync-rooms.mjs'
import { updateProject, getProjectsDir, listProjects, aggregateBookToc, sourceLifecycleStore, projectDir, deleteProject } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'
import { loadServerConfig } from '../../shared/config.mjs'
import { ForkTransport } from './build-transport.mjs'
import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { listProposalRefs } from './git-proposals.mjs'
import { reportBuildFailure } from './build-runner.mjs'

async function patchShape(docName, shapeId, propsPatch) {
  try {
    await updateShape(docName, shapeId, current => ({
      ...current,
      props: { ...(current.props || {}), ...(propsPatch || {}) },
    }))
  } catch (error) {
    if (!/not found/i.test(error?.message || '')) throw error
    await putShape(docName, {
      id: shapeId, typeName: 'shape', type: 'doc-version', x: 0, y: 0,
      rotation: 0, index: 'a0', parentId: 'page:page', isLocked: true,
      opacity: 0, meta: {},
      props: {
        w: 1, h: 1, commitHash: 'unknown', timestamp: Date.now(),
        buildReadyAt: Date.now(), warningsJson: '', errorsJson: '', ...(propsPatch || {}),
      },
    })
  }
}

async function regenerateBookTocs(name) {
  for (const project of await listProjects()) {
    if (project.format === 'book' && Array.isArray(project.members) && project.members.includes(name)) {
      aggregateBookToc(project.name, project.members)
    }
  }
}

const SINKS = { broadcastSignal, putShape, patchShape, writeSentinel, emitGlobalEvent, updateProject, regenerateBookTocs, reportBuildFailure }
const publicationLocks = new Map()

async function notifyPublishedHead(notifyHeadChanged, name, sourceRevision, logError = console.error) {
  try {
    await notifyHeadChanged?.(name, sourceRevision)
  } catch (error) {
    logError(`[build:${name}] published ${sourceRevision}, but notifying the source room failed: ${error?.message || error}`)
  }
}

function serializedPublication(name, operation) {
  const previous = publicationLocks.get(name) || Promise.resolve()
  const current = previous.then(operation, operation)
  // `.catch` on the TRACKING chain only. The caller still gets `current` and
  // still sees the rejection; without this the bookkeeping copy is a second
  // rejected promise nobody handles, so any publication that throws becomes an
  // unhandled rejection in the server process. Reachable since publishing
  // started refusing an instance that is missing something it cannot replace.
  const tracked = current.finally(() => {
    if (publicationLocks.get(name) === tracked) publicationLocks.delete(name)
  }).catch(() => {})
  publicationLocks.set(name, tracked)
  return current
}

function moveAside(live, transaction, name) {
  const held = join(transaction, `old-${name}`)
  if (existsSync(live)) renameSync(live, held)
  return held
}

function restoreAside(live, held) {
  if (!existsSync(held)) return
  if (existsSync(live)) rmSync(live, { recursive: true, force: true })
  renameSync(held, live)
}

// The only files a FAILED build is allowed to move into the live project.
// Named here, once, so the set is the thing you read rather than something you
// reconstruct from a call site: a failed build must never replace a working
// render, so `source`, `output` and `build-cache` are absent by construction
// and cannot be added by editing a caller.
// The items publishing REPLACES wholesale: each is renamed aside and swapped
// for the build instance's copy. Anything living inside one of these does not
// survive a build unless the revision named it. Exported so the containment
// test reads this list rather than a second copy of it that can drift.
export const PUBLISH_REPLACED_ITEMS = Object.freeze(['source', 'output', 'build-cache', 'build.log', 'latex.log'])

// Which of the replaced items a build instance may legitimately be missing.
// `build-cache` is an optional cache, and a build that produced no `latex.log`
// clears the stale one — which is why the swap in `publishBuildInstance` moves
// every item aside whether or not it was staged.
//
// `source` and `output` are deliberately NOT here, for one reason: swapping
// either for nothing destroys the only copy of something. An absent `source`
// deletes the project's source. An absent `output` blanks the published render
// and takes `relevant-files.json` with it, so the next push reads
// `no-relevant-files-yet`, renders, and puts it all back — which makes it
// intermittent rather than obvious. A build that rendered nothing is a failed
// build, and a failed build must never replace a working render.
const OPTIONALLY_ABSENT_PUBLISHED_ITEMS = new Set(['build-cache', 'build.log', 'latex.log'])

const BUILD_DIAGNOSTIC_FILES = ['build.log', 'latex.log']

/**
 * Carry a failed build's diagnostics out of its instance before the instance is
 * destroyed. This is NOT a publication: it takes no head, moves no artifacts,
 * and does not advance any revision — a failed build's render must stay the
 * last good one, which is the whole point of building in an instance.
 *
 * Without this the log dies with the instance, and `extractBuildErrors` reads a
 * live project that has none — so `build/status` says `error` while
 * `tlda project errors` says `Clean.` about the same build.
 */
export function publishBuildDiagnostics(name, instanceProject, failureReason = null) {
  const liveProject = projectDir(name)
  const copied = []
  for (const file of instanceProject ? BUILD_DIAGNOSTIC_FILES : []) {
    const from = join(instanceProject, file)
    if (!existsSync(from)) continue
    // Written, not renamed: the instance is about to be removed wholesale, and
    // a rename out of it would leave the two halves of a failure in different
    // places if the removal then failed.
    cpSync(from, join(liveProject, file))
    copied.push(file)
  }

  // A build can fail BEFORE it has an instance to log into — resolving the
  // source revision, opening the lifecycle store, or materializing the instance
  // itself all run first, and `instanceProject` is still null for every one of
  // them. There was nothing to carry out and so nothing was written anywhere,
  // which is the case that reads as "failed and left no log" with no defect
  // visible in any build the reader can find. The reason is the only account
  // that exists, so it becomes the log. When an instance log does exist, keep
  // it and append the outer failure: that is the only error after an inner
  // build which reached `Build complete` but failed at publication or IPC.
  let wrote = null
  if (failureReason) {
    try {
      const buildLog = join(liveProject, 'build.log')
      if (copied.includes('build.log')) {
        const separator = readFileSync(buildLog, 'utf8').endsWith('\n') ? '' : '\n'
        appendFileSync(buildLog, `${separator}[build] ${failureReason}\n`)
      }
      else writeFileSync(buildLog, `[build] ${failureReason}\n`)
      wrote = 'build.log'
    } catch (e) {
      // Never let recording the reason replace the failure being recorded.
      console.error(`[build] could not write failure log for ${name}: ${e?.message || e}`)
    }
  }
  return { copied, wrote }
}

/**
 * @param {string[]} replacedItems — which of `PUBLISH_REPLACED_ITEMS` this
 *   publication swaps. A build that rendered replaces all of them. A build whose
 *   changed files were outside the tree the render reads never produced an
 *   `output/`, so it passes `['source']`: the source and the head advance, and
 *   the last good render stays published.
 *
 *   Seeding the previous render into the instance so this function could copy it
 *   back out was the alternative, and it is worse — a build instance would be
 *   pretending a build happened, which is the one thing this repository is most
 *   careful not to let a word do.
 */
export async function publishBuildInstance(name, sourceRevision, acceptSeq, instanceProject, reports = [], replacedItems = PUBLISH_REPLACED_ITEMS, reportSinks = SINKS) {
  return serializedPublication(name, async () => {
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const expectedHead = await git.head(name)
    if (expectedHead && !await git.isAncestor(expectedHead, sourceRevision)) {
      return { published: false, stale: true, sourceRevision, currentHead: expectedHead }
    }

    const liveProject = projectDir(name)
    // Checked BEFORE the transaction directory exists, so a refusal leaves
    // nothing behind: `recoverBuildPublications` only cleans up transactions
    // that got as far as writing their marker, and the marker is written below.
    //
    // See OPTIONALLY_ABSENT_PUBLISHED_ITEMS for which absences are normal.
    // Anything outside it stops the publication rather than being swapped for
    // nothing, because the swap further down moves every item aside whether or
    // not it was staged — so an unguarded absence is a silent deletion.
    const staging = []
    for (const item of replacedItems) {
      if (existsSync(join(instanceProject, item))) staging.push(item)
      else if (!OPTIONALLY_ABSENT_PUBLISHED_ITEMS.has(item)) {
        throw new Error(`build instance for ${name} has no ${item} to publish`)
      }
    }
    const transaction = join(liveProject, `.build-publish-${randomUUID()}`)
    mkdirSync(transaction, { recursive: true })
    // Async, not `cpSync`. The build instance is created under
    // `mkdtempSync(tmpdir())` while the live project is on the volume, so this
    // is a cross-filesystem copy of the whole render — 936 MB for the largest
    // output tree here. Synchronously that blocked the event loop for the
    // duration: measured at 1,198 ms for a 150 MB tree on a local disk, and a
    // 101-second whole-server stall in production on 2026-08-25T09:41Z.
    //
    // Awaiting here is safe because `serializedPublication` chains publications
    // per project, so no second publication of this project can interleave, and
    // the function already awaits git reads inside the same transaction.
    for (const item of staging) {
      await cp(join(instanceProject, item), join(transaction, `new-${item}`), {
        recursive: true,
        verbatimSymlinks: true,
      })
    }
    writeFileSync(join(transaction, 'publication.json'), JSON.stringify({
      version: 1, project: name, expectedHead, sourceRevision,
    }))

    const old = {}
    let headMoved = false
    try {
      const currentHead = await git.head(name)
      if (currentHead !== expectedHead || (currentHead && !await git.isAncestor(currentHead, sourceRevision))) {
        return { published: false, stale: true, sourceRevision, currentHead }
      }
      for (const item of replacedItems) {
        old[item] = moveAside(join(liveProject, item), transaction, item)
        const staged = join(transaction, `new-${item}`)
        if (existsSync(staged)) renameSync(staged, join(liveProject, item))
      }
      await git.advanceHead(name, sourceRevision, expectedHead)
      headMoved = true

      // These reports were produced against this immutable instance. Apply
      // them only after the same revision owns both published artifacts and
      // the shared head. Old source-lifecycle/mirror reports are not a second
      // queue or source authority and are deliberately not replayed.
      for (const report of reports) {
        if (['publishBuildInstance', 'recordBuildResult', 'mirrorShadow'].includes(report.method)) continue
        const sink = reportSinks[report.method]
        if (sink) await sink(...(report.args || []))
      }
      lifecycle.recordRevisionAdmission(name, sourceRevision, acceptSeq)
      // The replaced set is the record of what this build produced, so it is
      // also the honest answer to which phase to write: no `output` means
      // nothing rendered, which is `not_required` rather than `built`.
      // `projectRevisionStatus` already reads that state; nothing has been able
      // to produce it since the accept path was rewritten.
      const rendered = replacedItems.includes('output')
      lifecycle.recordRevisionPhase(name, sourceRevision, 'build', rendered ? 'built' : 'not_required', { ok: true })
      return { published: true, sourceRevision, previousHead: expectedHead }
    } catch (error) {
      if (!headMoved) {
        for (const item of PUBLISH_REPLACED_ITEMS) {
          restoreAside(join(liveProject, item), old[item])
        }
      }
      throw error
    } finally {
      // A process crash leaves this directory and its marker. Startup recovery
      // uses the Git ref to choose the only honest side before removing it.
      //
      // Async for the same reason as the copy above, and it is the same size:
      // after a successful swap this directory holds the PREVIOUS render, moved
      // aside by `moveAside`. Deleting a 936 MB tree synchronously blocks the
      // loop exactly as copying one does, so fixing only the copy would have
      // left half the stall in place.
      await rm(transaction, { recursive: true, force: true })
    }
  })
}

export async function recoverBuildPublications() {
  for (const project of await listProjects()) {
    const liveProject = projectDir(project.name)
    for (const entry of readdirSync(liveProject, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.build-publish-')) continue
      const transaction = join(liveProject, entry.name)
      const markerPath = join(transaction, 'publication.json')
      if (!existsSync(markerPath)) continue
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      const git = await (await sourceLifecycleStore(project.name)).gitRepository()
      const head = await git.head(project.name)
      if (head !== marker.sourceRevision) {
        for (const item of PUBLISH_REPLACED_ITEMS) {
          restoreAside(join(liveProject, item), join(transaction, `old-${item}`))
        }
      }
      rmSync(transaction, { recursive: true, force: true })
    }
  }
}

export function createDispatcherWithOptions(transport, options = {}) {
  const sinks = { ...SINKS, ...(options.sinks || {}) }
  let queue
  queue = createBuildQueue({
    transport,
    getProjectsDir,
    store: options.store || new BuildQueueStore(options.storePath || ':memory:'),
    serializeProject: serializedPublication,
    recordAdmission,
    recordDisposition,
    async getCurrentHead(name) {
      return (await (await sourceLifecycleStore(name)).gitRepository()).head(name)
    },
    async isAncestor(ancestor, descendant, name) {
      return (await sourceLifecycleStore(name)).isAncestor(ancestor, descendant)
    },
    random: options.random || Math.random,
    async relayMessage(name, message, job) {
      if (message?.t === 'report') {
        // Build output, streamed while the build runs. Everything else arriving
        // as `t: 'report'` is still discarded here, as it always was.
        if (message.m === 'buildOutput') {
          const [project, line, skipped] = message.a || []
          console.log(`[build:${project}] ${line}${skipped ? `  (+${skipped} lines)` : ''}`)
        }
        return null
      }
      if (message?.t !== 'rpc') return null
      if (message.m === 'recordRevisionPhase') return null
      if (message.m === 'recordBuildResult') {
        const [name, sourceRevision, _acceptSeq, state, result] = message.a || []
        const lifecycle = await sourceLifecycleStore(name)
        return lifecycle.recordRevisionPhase(name, sourceRevision, 'build', state, result)
      }
      if (message.m === 'publishBuildDiagnostics') {
        // Deliberately not routed through `sinks`: this runs on the failure
        // path, and a missing sink there would throw inside the handler for a
        // build that has already failed, losing the log for the second time.
        return publishBuildDiagnostics(...(message.a || []))
      }
      if (message.m === 'publishBuildInstance') {
        // Destructured rather than spread: `sinks` has to stay the last
        // argument, and a spread makes that depend on the worker's arity.
        const [pName, pRevision, pAcceptSeq, pInstance, pReports, pReplaced] = message.a || []
        // IPC is JSON, so an omitted set arrives as `null` rather than
        // `undefined` and would never reach the signature's default.
        const result = await publishBuildInstance(
          pName, pRevision, pAcceptSeq, pInstance, pReports, pReplaced || PUBLISH_REPLACED_ITEMS, sinks)
        if (!result.published) throw new Error(`stale build ${job.sourceRevision} cannot publish over ${result.currentHead || 'no head'}`)
        await queue.publishedHeadChanged(name, job.sourceRevision)
        await notifyPublishedHead(options.notifyHeadChanged, name, job.sourceRevision)
        return result
      }
      const sink = sinks[message.m]
      if (!sink) throw new Error(`unknown build worker RPC: ${message.m}`)
      return sink(...(message.a || []))
    },
  }, options)
  return queue
}

export function createDispatcher(transport) {
  return createDispatcherWithOptions(transport)
}

let headNotifier = null
let activeDispatcher = null

export function setBuildHeadNotifier(notifier) {
  headNotifier = typeof notifier === 'function' ? notifier : null
}

export function initBuildDispatcher() {
  if (activeDispatcher) return activeDispatcher
  const config = loadServerConfig()
  activeDispatcher = createDispatcherWithOptions(ForkTransport, {
    maxConcurrency: config.buildMaxConcurrency,
    priority: config.buildPriority,
    stallTimeoutMs: config.buildStallTimeoutMs,
    storePath: join(getProjectsDir(), '.build-queue.sqlite'),
    notifyHeadChanged: (...args) => headNotifier?.(...args),
  })
  return activeDispatcher
}

function dispatcher() { return activeDispatcher || initBuildDispatcher() }

async function recordAdmission(job) {
  return (await sourceLifecycleStore(job.name))
    .recordRevisionAdmission(job.name, job.sourceRevision, job.acceptSeq)
}

/**
 * Record a build's outcome on the PROJECT when the worker could not record it
 * itself.
 *
 * The worker's own catch sets the project's status and writes its reason, and
 * for every failure that throws inside the worker that is what happens. A
 * worker that dies without running it — SIGKILL, the OOM killer, its parent
 * going away — leaves the queue row settled correctly by `onExit` and the
 * project untouched: `buildStatus` stays at the `building` that build-runner
 * set when it started, and nothing writes a log. Measured on a live box: a
 * project reading `building` with `logMissing` for six days, whose queue row
 * had long since settled.
 *
 * `settle` has always called this hook and nothing has ever supplied it, so
 * the admission half of the queue's reporting was wired and the disposition
 * half was not.
 *
 * Only `failed`. A row settles to `killed` for `superseded`, `needs-rebase`
 * and `cancelled`, none of which are a build that went wrong, and marking a
 * project broken because a newer revision replaced its build would be a false
 * report. `complete` is already the worker's to record, and re-recording it
 * here would race the success it just wrote.
 */
async function recordDisposition(job, state, result = null) {
  if (state !== 'failed') return
  const reason = result?.error || result?.reason || 'build worker exited without recording a reason'
  try {
    await updateProject(job.name, { buildStatus: 'error' })
  } catch (e) {
    // Best effort, and deliberately not fatal: this runs from the queue's
    // settle path, where throwing would abandon the rest of the disposition and
    // take `drain()` with it — so a project whose status could not be written
    // would also stop the next build from starting. The log below is the more
    // important of the two records and is still worth writing without it.
    console.error(`[build] could not record failed disposition for ${job.name}: ${e?.message || e}`)
  }
  // No instance: this path runs after the worker is gone and its instance has
  // been removed, so the reason is the only account that exists. This is the
  // same call the worker makes, doing the same thing with the same writer.
  try {
    publishBuildDiagnostics(job.name, null, reason)
  } catch (e) {
    // Never let recording the reason replace the failure being recorded.
    console.error(`[build] could not write failure log for ${job.name}: ${e?.message || e}`)
  }
}

export async function admitProposal(submission, options = {}) {
  return dispatcher().admitBuild(submission.project, submission, options)
}
export const killBuild = name => dispatcher().killBuild(name)
export const killAllDispatchedBuilds = () => dispatcher().killAllDispatchedBuilds()
export const isBuilding = name => dispatcher().isBuilding(name)
export const isBuildKindPending = (name, kind) => dispatcher().isBuildKindPending(name, kind)

export async function deleteProjectAndBuildSubmissions(name, queue = dispatcher()) {
  await queue.removeProject(name)
  await deleteProject(name)
}

export async function recoverProposalBuilds() {
  const queue = dispatcher()
  for (const project of await listProjects()) {
    const git = await (await sourceLifecycleStore(project.name)).gitRepository()
    for (const proposal of await listProposalRefs(git.gitDir)) {
      await queue.admitBuild(project.name, proposal)
    }
  }
  await queue.recover()
}
