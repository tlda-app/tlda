import {
  appendFileSync,
  cpSync,
  existsSync,
  statSync,
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
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { broadcastSignal, putShape, updateShape, emitGlobalEvent } from './sync-rooms.mjs'
import { updateProject, getProjectsDir, listProjects, aggregateBookToc, sourceLifecycleStore, projectDir, deleteProject, readProject } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'
import { loadServerConfig } from '../../shared/config.mjs'
import { ForkTransport, createRemoteTransport } from './build-transport.mjs'
import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { listProposalRefs } from './git-proposals.mjs'
import { fileURLToPath } from 'node:url'
import { assemblePreviewCopy, copyBuildOutputToPreview, sendPreviewCopy } from './publish-copy.mjs'

/**
 * Put what just built in front of the preview, on the box that built it.
 *
 * This is the step that makes the loop a loop: Skip edits a page, the build
 * runs where it already runs, and the page is at the preview URL without him
 * typing anything. Everything before this exists so that a copy can be made;
 * this is what makes one without being asked.
 *
 * OPT-IN BY INTENT. A box refreshes a preview because someone named the project
 * whose builds it shows, not because of what the box is called. Neither
 * variable set is the standing behaviour and every other deployment is
 * untouched.
 *
 * NON-FATAL, DELIBERATELY. This runs after the build has published; a copy that
 * fails must not turn a build that succeeded into one that failed. It says what
 * went wrong and the build stands -- the previous copy keeps serving, which is
 * the same answer the swap gives for a transfer that dies halfway.
 */
async function refreshPreviewCopy(name) {
  const project = process.env.TLDA_PREVIEW_PROJECT
  const configDir = process.env.TLDA_PREVIEW_DESTINATION
  const host = process.env.TLDA_PREVIEW_HOST
  const staticDir = process.env.TLDA_STATIC_DIR
  if (!project || !configDir || project !== name || !(host || staticDir)) return
  // From this module rather than from PROJECTS_DIR: `dist` sits beside
  // `server/`, and PROJECTS_DIR is overridden per instance on a box that runs
  // more than one server -- deriving from it would point a second instance at
  // a directory that does not exist.
  const distDir = fileURLToPath(new URL('../../dist', import.meta.url))
  const outputDir = join(projectDir(name), 'output')
  try {
    const record = await readProject(name)
    const document = { name, record: record || { name } }
    // A HOST THAT IS NOT THIS BOX is tried first, so that a deployment which
    // names one never silently falls back to serving the copy itself. The
    // same-box path stays for a deployment that is both.
    if (host) {
      const staging = await mkdtemp(join(tmpdir(), `tlda-preview-${name}-`))
      try {
        const patched = await assemblePreviewCopy({ outputDir, into: staging, distDir, configDir, document })
        const sent = await sendPreviewCopy({
          from: staging,
          url: `${host.replace(/\/$/, '')}/api/preview-copy`,
          secret: process.env.TLDA_PREVIEW_COPY_SECRET || '',
        })
        console.log(`[preview] ${name} sent to ${host} — ${sent.bytes} bytes, pointed at ${patched.config.store.ws}${patched.config.licenseKey ? '' : ' (unlicensed)'}`)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      return
    }
    const result = await copyBuildOutputToPreview({ outputDir, staticDir, distDir, configDir, document })
    console.log(`[preview] ${name} is now at ${result.staticDir}, pointed at ${result.store}${result.licensed ? '' : ' (unlicensed)'}`)
  } catch (error) {
    // Swallowed on purpose, and this is the reason: the build has ALREADY
    // published by the time this runs. Rethrowing would take a build that
    // succeeded and report it as failed, which is a worse lie than a stale
    // preview -- and the previous copy is still serving, unharmed, because the
    // new one is assembled beside it and only a rename puts it in front.
    // What the operator needs is this line, naming the project and the cause.
    console.error(`[preview] ${name} built and published, but the preview copy was not refreshed: ${error.message}`)
  }
}
import { projectRevisionStatus } from './source-lifecycle.mjs'
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

/**
 * Which RPC arguments name the project and the revision a build is FOR.
 *
 * The relay has always taken these from the worker and acted on them. Under
 * `fork` that was safe by construction -- the worker is the server's own child,
 * started with this job and nothing else -- so nothing compared them to the job,
 * and the compare-and-swap in `publishBuildInstance` checks the worker's
 * revision against the published HEAD, which is a different question.
 *
 * A remote transport turns that into a boundary. The process on the other end is
 * not the server's child; with a persistent workspace it can hold a revision the
 * job never named, and "what the worker says it built" and "what this job is"
 * become two values that can disagree. So they are compared here, once, for
 * every method that carries them.
 *
 * `broadcastSignal` and the shape writes are deliberately absent: their first
 * argument is a ROOM (`doc-<name>`), not a project, and a check written as
 * though it were a project would be a check that cannot do what it says.
 */
const JOB_BOUND_RPC_ARGUMENTS = Object.freeze({
  publishBuildInstance: { name: 0, revision: 1 },
  publishBuildDiagnostics: { name: 0 },
  recordBuildResult: { name: 0, revision: 1 },
  reportBuildFailure: { name: 0, revision: 2 },
})

function assertRpcBelongsToJob(message, job) {
  const bound = JOB_BOUND_RPC_ARGUMENTS[message?.m]
  if (!bound) return
  const args = message.a || []
  // Compared without an `undefined` escape, and that absence is the check.
  // An argument that is simply MISSING arrives as `undefined`, and a guard that
  // skipped `undefined` would let `a: []` walk past it untouched while catching
  // `a: [null]` — because `null !== undefined`. That asymmetry is invisible at
  // the call site, and this file already records the same surprise in the other
  // direction: "IPC is JSON, so an omitted set arrives as `null` rather than
  // `undefined`". An absent name is not this job's name, so it throws.
  //
  // The degenerate case is safe rather than excluded: a job with no
  // `sourceRevision` compares `undefined` to `undefined`, which is equal, so
  // nothing fires.
  const claimedName = args[bound.name]
  if (claimedName !== job.name) {
    throw new Error(`build worker for ${job.name} sent ${message.m} for ${claimedName}; a build may only act on its own project`)
  }
  if (bound.revision === undefined) return
  const claimedRevision = args[bound.revision]
  if (claimedRevision !== job.sourceRevision) {
    throw new Error(`build worker for ${job.name} sent ${message.m} for revision ${claimedRevision}; this build is ${job.sourceRevision}`)
  }
}
const publicationLocks = new Map()

async function notifyPublishedHead(notifyHeadChanged, name, sourceRevision, acceptSeq = null, logError = console.error) {
  try {
    await notifyHeadChanged?.(name, sourceRevision, acceptSeq)
  } catch (error) {
    logError(`[build:${name}] published ${sourceRevision}, but notifying the source room failed: ${error?.message || error}`)
  }
}

export function serializedPublication(name, operation) {
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

// A replaced item may be a PATH (`.quarto/xref`), not just a top-level name,
// so its slot inside the transaction directory cannot contain the separator —
// `old-.quarto/xref` would silently want a `old-.quarto` directory that nothing
// creates, and `renameSync` would fail mid-swap with items already moved aside.
// Flattening the separator keeps every slot a single entry, which is what the
// transaction directory and `recoverBuildPublications` both assume.
const transactionSlot = item => item.replaceAll('/', '__')

function moveAside(live, transaction, name) {
  const held = join(transaction, `old-${transactionSlot(name)}`)
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
//
// The `.quarto/*` entries are Quarto's project state, and they are here rather
// than as a whole `.quarto` because that directory is 450 MB in the real course
// and almost all of it is a freeze mirror Quarto rebuilds from the committed
// `_freeze/`. These three are 4.0 MB together and are the parts nothing else
// can reconstruct: `xref/` is the crossref index, `idx/` the per-file target
// index, `cites/` the citation index. Replacing each as a unit is deliberate —
// it prunes entries for documents that no longer exist, which merging would
// accumulate instead.
export const PUBLISH_REPLACED_ITEMS = Object.freeze([
  'source', 'output', 'build-cache', 'build.log', 'latex.log',
  '_freeze', '.quarto/xref', '.quarto/idx', '.quarto/cites',
])

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
//
// The `.quarto/*` entries MUST be here. Only a Quarto project produces them, so
// for every markdown, tex and html project the instance has none — and anything
// outside this set throws rather than publishing. Omitting them would refuse
// the publication of every non-Quarto build in the system, which is a total
// outage wearing the costume of a cache change.
const OPTIONALLY_ABSENT_PUBLISHED_ITEMS = new Set([
  'build-cache', 'build.log', 'latex.log',
  '_freeze', '.quarto/xref', '.quarto/idx', '.quarto/cites',
])

const BUILD_DIAGNOSTIC_FILES = ['build.log', 'latex.log']

// Where a failed instance's freeze can be, and both cases are real. The success
// path moves it beside `output/` just before the publication sweep; a render
// that threw never got there, so it is still inside the render directory.
const FAILED_INSTANCE_FREEZE_LOCATIONS = ['_freeze', join('output', '_freeze')]

/**
 * Carry a failed build's freeze out of its instance, MERGED into whatever the
 * project already has.
 *
 * WHY A FAILED BUILD'S FREEZE IS WORTH KEEPING. Quarto's freeze is the record of
 * executing a document, keyed by the md5 of that document's source. A build that
 * rendered 48 of 73 chapters and then died computed 48 of those records, and
 * they were destroyed with the instance -- so the next build started cold, and
 * so did the one after it. Measured 2026-09-13: a cold render exceeded the
 * fifteen-minute `RENDER_TIMEOUT_MS`, was SIGTERMed at document 48, discarded
 * everything it had executed, and the next attempt began again from nothing.
 * **That is a loop with no exit**, and it is the idempotence failure `AGENTS.md`
 * describes -- run it again and converge is exactly what it could not do.
 *
 * MERGED, NOT REPLACED, and that is the whole correctness of it. A failed build
 * executed a SUBSET; the project may hold records for documents this run never
 * reached. Replacing would throw those away and leave the cache no better than
 * before -- which is the bug, not the fix.
 *
 * It cannot publish a wrong result. Quarto compares the stored hash against the
 * source before thawing, so a record that does not match is re-executed. The
 * worst a carried record can do is be ignored.
 *
 * It is also not an artifact in the sense the rest of this file protects: the
 * freeze sits beside `output/`, nothing serves it over `/docs/` and nothing
 * promotes it. The last good render stays the published one.
 */
export function carryFreezeOutOfFailedInstance(name, instanceProject) {
  if (!instanceProject) return null
  const target = join(projectDir(name), '_freeze')
  for (const location of FAILED_INSTANCE_FREEZE_LOCATIONS) {
    const from = join(instanceProject, location)
    if (!existsSync(from)) continue
    // A DIRECTORY, checked rather than assumed. `cpSync` does not refuse a file
    // here -- it copies it happily and leaves a FILE named `_freeze` in the
    // project, which the next build's staging then treats as the freeze tree.
    // Measured while testing this: the copy returned success and produced a
    // cache that cannot be read, which is worse than the throw I was guarding
    // against because nothing reports it.
    if (!statSync(from).isDirectory()) continue
    // `force: true` overwrites same-named records and leaves the rest, which is
    // the merge. A newer record for a document beats an older one for the same
    // document, and documents this build never touched keep what they had.
    cpSync(from, target, { recursive: true, force: true })
    return location
  }
  return null
}

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

  // Before the instance is removed, and for the same reason as the logs: it
  // exists nowhere else. Unlike the logs it is not diagnostics -- it is the work
  // this build actually completed, and discarding it is what made repeated
  // builds restart from cold instead of converging.
  //
  // CAUGHT, and the ordering is why. The failure reason is written below, and it
  // is the only account of why this build died. An unguarded copy here -- a full
  // disk, an EACCES, a tree that vanished under it -- would throw past that write
  // and destroy the diagnostic to save a cache. A cache is worth one wasted
  // render; the reason is worth the next person's night.
  let carriedFreeze = null
  try {
    carriedFreeze = carryFreezeOutOfFailedInstance(name, instanceProject)
  } catch (e) {
    // Swallowed deliberately: this is a cache, and the failure reason written
    // below is the only account of why the build died. Rethrowing here would
    // destroy that account to report a lost cache -- one wasted render against
    // the next person having nothing to read. The cache's absence costs a
    // re-execution and says so in the next build's timings.
    console.error(`[build] could not carry the freeze out of ${name}'s failed instance: ${e?.message || e}`)
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
  return { copied, wrote, carriedFreeze }
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
    /**
     * Say that this publication did not happen, and why.
     *
     * Every exit from here except the last one used to write nothing. A build
     * could render, publish into its instance, fail the swap, roll back
     * correctly -- and leave no record at all, so the revision's `build` phase
     * stayed `pending` and `projectRevisionStatus` reported the project
     * `building` FOREVER. On 2026-09-20 that was live on the course for four
     * hours; the only way to learn otherwise was to notice that the stored
     * record said success while the derived status said building.
     *
     * The state is one `projectRevisionStatus` already reads, so nothing new is
     * invented and neither value can be mistaken for success. THE REASON IS THE
     * POINT: a record saying only that it failed leaves the next reader where
     * that four hours started.
     *
     * Recording must never mask the original failure, so it cannot throw: the
     * admission is written first because `recordRevisionPhase` refuses a
     * revision it has never seen, and a failure to record is reported beside
     * the thing it was trying to describe rather than in place of it.
     */
    const recordNotPublished = async (state, detail) => {
      try {
        lifecycle.recordRevisionAdmission(name, sourceRevision, acceptSeq)
        lifecycle.recordRevisionPhase(name, sourceRevision, 'build', state, { ok: false, ...detail })
      } catch (recordError) {
        // Swallowed deliberately: this runs on the failure path, and its only
        // job is to describe a failure that has already happened. Rethrowing
        // would REPLACE the real error with one about the bookkeeping, so the
        // caller would be told that recording broke instead of that publishing
        // did -- which is the same class of defect this function exists to fix.
        // Reported beside the original rather than in place of it.
        console.error(`[publish:${name}] ${sourceRevision} ${state} and could not be recorded: ${recordError.message}`)
      }
    }
    const git = await lifecycle.gitRepository()
    const expectedHead = await git.head(name)
    if (expectedHead && !await git.isAncestor(expectedHead, sourceRevision)) {
      await recordNotPublished('superseded', {
        reason: 'the project head is not an ancestor of this revision, so this build is behind what the project holds',
        head: expectedHead,
        stage: 'before-swap',
      })
      return { published: false, stale: true, sourceRevision, currentHead: expectedHead }
    }

    const liveProject = projectDir(name)
    // `headMoved` lives out here so the recorder below can say which side of
    // the head advance a failure happened on. Everything from the instance
    // check down is inside one try: the FIRST version of this recorder sat only
    // in the inner catch, and a test caught it missing the throw that refuses
    // an instance with nothing to publish -- which is before the transaction
    // exists and so was still leaving no record at all. An exit that writes
    // nothing is the defect; where in the function it exits from is not.
    let headMoved = false
    try {
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
      await cp(join(instanceProject, item), join(transaction, `new-${transactionSlot(item)}`), {
        recursive: true,
        verbatimSymlinks: true,
      })
    }
    writeFileSync(join(transaction, 'publication.json'), JSON.stringify({
      version: 1, project: name, expectedHead, sourceRevision,
    }))

    const old = {}
    try {
      const currentHead = await git.head(name)
      if (currentHead !== expectedHead || (currentHead && !await git.isAncestor(currentHead, sourceRevision))) {
        await recordNotPublished('superseded', {
          reason: currentHead === expectedHead
            ? 'the project head is not an ancestor of this revision, so this build is behind what the project holds'
            : 'the project head moved while this publication was preparing',
          head: currentHead,
          expectedHead,
          stage: 'at-swap',
        })
        return { published: false, stale: true, sourceRevision, currentHead }
      }
      for (const item of replacedItems) {
        old[item] = moveAside(join(liveProject, item), transaction, item)
        const staged = join(transaction, `new-${transactionSlot(item)}`)
        if (existsSync(staged)) {
          // A pathed item (`.quarto/xref`) needs its parent to exist in the live
          // project: the whole point is that `.quarto` did NOT survive.
          mkdirSync(dirname(join(liveProject, item)), { recursive: true })
          renameSync(staged, join(liveProject, item))
        }
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
    } catch (error) {
      // `headMoved` is the stage, and it is the one thing a reader needs:
      // false means the swap was undone and the project still serves its
      // previous render, true means the head advanced and the failure came
      // after.
      await recordNotPublished('build_failed', {
        reason: error.message,
        stage: headMoved ? 'after-head-advanced' : 'rolled-back',
        head: headMoved ? sourceRevision : expectedHead,
      })
      throw error
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
          restoreAside(join(liveProject, item), join(transaction, `old-${transactionSlot(item)}`))
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
      // Before any of them, so one check covers the methods below rather than
      // each of them carrying its own half of it.
      assertRpcBelongsToJob(message, job)
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
        // `job.acceptSeq`, not the wire's `pAcceptSeq`, for the same reason this
        // line already prefers `job.sourceRevision`: the server's own record is
        // authoritative. A missing or malformed wire value would leave the
        // delivery's warning layer silently unscoped and therefore off.
        await notifyPublishedHead(options.notifyHeadChanged, name, job.sourceRevision, job.acceptSeq)
        await refreshPreviewCopy(name)
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

/**
 * Which machine this deployment's builds run on.
 *
 * Absent `buildExecutor` is the normal case and the historical one: the server
 * forks its own worker. Configured, the same build runs on the named machine
 * through a transport that carries the same envelopes — so everything below
 * this line, including the publication and its compare-and-swap, is unchanged
 * and still happens here.
 *
 * Announced rather than silent. A deployment that renders somewhere else is the
 * first thing a reader needs when a build behaves unexpectedly, and it is
 * otherwise invisible in every log the build itself writes.
 */
export function buildTransportFor(config, makeRemote = createRemoteTransport) {
  const executor = config.buildExecutor
  if (!executor?.url) return ForkTransport
  console.log(`[build] builds for this deployment run on ${executor.url}, not on this machine`)

  // The two tokens come from the environment, and under
  // `tokensFromEnvironmentOnly` they come from NOWHERE ELSE.
  //
  // Same shape as `server/lib/auth.mjs` does for TLDA_TOKEN_READ/RW, and for the
  // same reason: `config/deployments/` is tracked and public, so a token written
  // there is a committed credential. `AGENTS.md` forbids it and the deployment
  // file this key lives in says so about itself.
  //
  // The `null` rather than a fallback is the load-bearing part. A hosted box
  // declares that its secrets come from its secret store; letting a config field
  // win there would mean a committed token silently outranking the deployed one,
  // which is the state that reads as configured and behaves as something else.
  const envTokensOnly = !!config.tokensFromEnvironmentOnly
  const token = process.env.TLDA_BUILD_EXECUTOR_TOKEN || (envTokensOnly ? null : executor.token)
  const gitToken = process.env.TLDA_BUILD_EXECUTOR_GIT_TOKEN || (envTokensOnly ? null : executor.git?.token)

  // Named, never valued. A config token that is being ignored is worth saying —
  // somebody wrote it expecting it to work — but printing it would put the
  // secret in the log the warning exists to make readable.
  if (envTokensOnly && executor.token) {
    console.warn('[build] buildExecutor.token in server.yaml is ignored under tokensFromEnvironmentOnly; TLDA_BUILD_EXECUTOR_TOKEN is authoritative')
  }
  if (envTokensOnly && executor.git?.token) {
    console.warn('[build] buildExecutor.git.token in server.yaml is ignored under tokensFromEnvironmentOnly; TLDA_BUILD_EXECUTOR_GIT_TOKEN is authoritative')
  }

  return makeRemote({
    executorUrl: executor.url,
    token,
    git: executor.git ? { ...executor.git, token: gitToken } : executor.git,
    stagingRoot: join(getProjectsDir(), '.build-instances'),
    readProject,
    publishedHead: async name => (await (await sourceLifecycleStore(name)).gitRepository()).head(name),
  })
}

export function initBuildDispatcher() {
  if (activeDispatcher) return activeDispatcher
  const config = loadServerConfig()
  activeDispatcher = createDispatcherWithOptions(buildTransportFor(config), {
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
  const diagnostic = result?.errorStack ? `${reason}\n${result.errorStack}` : reason
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
    publishBuildDiagnostics(job.name, null, diagnostic)
  } catch (e) {
    // Never let recording the reason replace the failure being recorded.
    console.error(`[build] could not write failure log for ${job.name}: ${e?.message || e}`)
  }
}

export async function admitProposal(submission, options = {}) {
  return dispatcher().admitBuild(submission.project, submission, options)
}

/**
 * Run an already-accepted revision again, when its last build ended failed.
 *
 * NOT A REBUILD API. It re-admits one revision the queue already holds a
 * terminal row for, which is the single transition `admitBuild` already
 * implements under `retryTerminal` — the row is dropped and re-admitted as
 * pending. Nothing here proposes a revision, writes source, or invents a
 * daemon: the identifiers come from the row being retried, so a re-run lands on
 * the same branch and kind the original did.
 *
 * WHY IT HAS TO EXIST. A build is keyed on the source revision, so once a
 * revision's build has failed there is no way to run it again — re-submitting
 * identical bytes produces an identical revision and the source transaction
 * treats it as a no-op. Measured 2026-09-19 on the one real hand-in on the box:
 * an instructor re-upload returned 200 with every answer id and enqueued
 * nothing. A submission has no daemon binding either, so `rebuildLinkedProject`
 * cannot reach it. That left stored student work permanently unrenderable after
 * the render bug that broke it had been fixed, and the only workaround was
 * editing the student's file.
 *
 * `complete` is deliberately not retried. A succeeded build is not what this is
 * for, and re-running one would make this the general rebuild API it must not
 * become.
 */
export async function rerunFailedRevision(project) {
  const lifecycle = await sourceLifecycleStore(project)
  const { sourceRevision } = projectRevisionStatus(lifecycle.listRevisionLifecycles(project))
  if (!sourceRevision) return { ok: false, reason: 'no-accepted-revision' }

  const queue = dispatcher()
  const row = queue.store.get(project, sourceRevision)
  if (!row) return { ok: false, reason: 'no-build-record', revision: sourceRevision }
  if (!['failed', 'killed'].includes(row.state)) return { ok: false, reason: row.state, revision: sourceRevision }
  const admitted = await queue.admitBuild(
    project,
    { revision: sourceRevision, daemonId: row.daemon_id, branch: row.branch, kind: row.kind },
    { retryTerminal: true },
  )
  return { ok: true, state: admitted.state, previousState: row.state, revision: sourceRevision }
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
