// Server-side build dispatcher. Replaces the inline `await runBuild(...)` calls.
// The server NEVER runs the build itself — it delegates to a BuildTransport (off
// the event loop), relays the worker's side-effects to the live rooms, and
// coalesces/serializes per project so rapid saves collapse to one build.

import { broadcastSignal, putShape, updateShape, emitGlobalEvent } from './sync-rooms.mjs'
import { updateProject, getProjectsDir, listProjects, aggregateBookToc, sourceLifecycleStore } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'
import { loadServerConfig } from '../../shared/config.mjs'
import { ForkTransport } from './build-transport.mjs'
import { createBuildQueue } from './build-queue.mjs'
import { mirrorShadow } from './build-runner.mjs'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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

export async function publishBuildInstance(name, sourceRevision, acceptSeq, instanceProject, reports = [], reportSinks = SINKS) {
  const lifecycle = await sourceLifecycleStore(name)
  const authority = await lifecycle.readAuthority()
  if (authority.currentRevision !== sourceRevision || authority.acceptSeq !== acceptSeq) {
    throw new Error(`stale build ${sourceRevision} is not authorized to publish over ${authority.currentRevision || 'no head'}`)
  }

  const liveProject = join(getProjectsDir(), name)
  const transaction = join(liveProject, `.build-publish-${randomUUID()}`)
  const stagedOutput = join(transaction, 'output')
  const stagedCache = join(transaction, 'build-cache')
  mkdirSync(transaction, { recursive: true })
  try {
    cpSync(join(instanceProject, 'output'), stagedOutput, { recursive: true })
    if (existsSync(join(instanceProject, 'build-cache'))) {
      cpSync(join(instanceProject, 'build-cache'), stagedCache, { recursive: true })
    }
    for (const file of ['build.log', 'latex.log']) {
      if (existsSync(join(instanceProject, file))) cpSync(join(instanceProject, file), join(transaction, file))
    }

    // Re-check after staging. The synchronous swaps below cannot interleave
    // with another server-side accept on this event loop.
    const stillCurrent = await lifecycle.readAuthority()
    if (stillCurrent.currentRevision !== sourceRevision || stillCurrent.acceptSeq !== acceptSeq) {
      throw new Error(`build ${sourceRevision} lost publication authority while staging`)
    }

    const oldOutput = join(transaction, 'old-output')
    const oldCache = join(transaction, 'old-cache')
    if (existsSync(join(liveProject, 'output'))) renameSync(join(liveProject, 'output'), oldOutput)
    renameSync(stagedOutput, join(liveProject, 'output'))
    if (existsSync(stagedCache)) {
      if (existsSync(join(liveProject, 'build-cache'))) renameSync(join(liveProject, 'build-cache'), oldCache)
      renameSync(stagedCache, join(liveProject, 'build-cache'))
    }
    for (const file of ['build.log', 'latex.log']) {
      const staged = join(transaction, file)
      if (existsSync(staged)) renameSync(staged, join(liveProject, file))
    }

    for (const report of reports) {
      const current = await lifecycle.readAuthority()
      if (current.currentRevision !== sourceRevision || current.acceptSeq !== acceptSeq) break
      const sink = reportSinks[report.method]
      if (!sink || report.method === 'publishBuildInstance') continue
      await sink(...(report.args || []))
    }
    return { published: true, sourceRevision, acceptSeq }
  } finally {
    rmSync(transaction, { recursive: true, force: true })
  }
}

async function regenerateBookTocs(name) {
  for (const project of await listProjects()) {
    if (project.format === 'book' && Array.isArray(project.members) && project.members.includes(name)) {
      aggregateBookToc(project.name, project.members)
    }
  }
}

const SINKS = { broadcastSignal, putShape, patchShape, writeSentinel, emitGlobalEvent, updateProject, mirrorShadow, regenerateBookTocs, publishBuildInstance }

export async function recordBuildResult(name, sourceRevision, acceptSeq, state, result = null) {
  if (!sourceRevision) return null
  const lifecycle = await sourceLifecycleStore(name)
  const current = lifecycle.readRevisionLifecycle(name, sourceRevision)
  if (!current) throw new Error(`Cannot record build result for unknown source revision ${sourceRevision}`)
  if (current.acceptSeq !== acceptSeq) throw new Error(`Build acceptSeq ${acceptSeq} does not match ${current.acceptSeq}`)
  if (state === 'build_failed' && current.version?.state === 'versioned' && current.mirror?.state === 'mirror_failed') {
    return lifecycle.recordRevisionPhase(name, sourceRevision, 'build', 'built', {
      ok: true,
      terminalPhase: 'mirror',
      workerError: result?.error || null,
    })
  }
  const terminal = lifecycle.recordRevisionPhase(name, sourceRevision, 'build', state, result)
  // The build says nothing about the mirror any more: mirroring is driven by
  // the accept, so a build that never ran has not "not reached" it -- it may
  // already have happened. Writing a phase this path does not own would race
  // the accept mirror and, being synchronous, would usually win.
  if (state !== 'built') {
    return lifecycle.recordRevisionPhase(name, sourceRevision, 'version', 'not_reached', { buildState: state })
  }
  const completed = lifecycle.readRevisionLifecycle(name, sourceRevision)
  if (completed.version?.state === 'pending') {
    lifecycle.recordRevisionPhase(name, sourceRevision, 'version', 'version_failed', { error: 'build completed without version disposition' })
  }
  return terminal
}

export async function recordRevisionPhase(name, sourceRevision, phase, state, result = null) {
  if (!sourceRevision) return null
  return (await sourceLifecycleStore(name)).recordRevisionPhase(name, sourceRevision, phase, state, result)
}

SINKS.recordBuildResult = recordBuildResult
SINKS.recordRevisionPhase = recordRevisionPhase

/**
 * Create a bound dispatcher instance. Transport is injected so the coalescing
 * logic is independently testable with a fake transport. Production callers use
 * the module-level exports which bind the configured transport at load time.
 */
export function createDispatcher(transport) {
  return createDispatcherWithOptions(transport)
}

export function createDispatcherWithOptions(transport, options = {}) {
  const sinks = { ...SINKS, ...(options.sinks || {}) }
  sinks.publishBuildInstance = (...args) => publishBuildInstance(...args, sinks)
  const acceptedHeads = new Map()
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
    recordDisposition(job, state, result) {
      return sinks.recordBuildResult(job.name, job.sourceRevision, job.acceptSeq, state, result)
    },
    getCurrentHead(name) {
      return acceptedHeads.get(name) ?? null
    },
    async isAncestor(ancestor, descendant, name) {
      if (!ancestor || !descendant) return false
      return (await sourceLifecycleStore(name)).isAncestor(ancestor, descendant)
    },
    random: options.random || Math.random,
  }, options)

  async function dispatchBuild(name, {
    kind = 'build', sourceRevision = null, acceptSeq = null, daemonId = null, basedOnRevision,
  } = {}) {
    if (!daemonId) throw new Error(`build submission for ${name}${sourceRevision ? `@${sourceRevision}` : ''} requires trusted daemon context`)
    if (!sourceRevision) throw new Error(`build submission for ${name} requires sourceRevision`)
    if (basedOnRevision === undefined) throw new Error(`build submission for ${name}@${sourceRevision} requires basedOnRevision`)
    const lifecycle = await sourceLifecycleStore(name)
    const current = lifecycle.readRevisionLifecycle(name, sourceRevision)
    if (!current) throw new Error(`Cannot lease build for unknown source revision ${sourceRevision}`)
    lifecycle.recordRevisionPhase(name, sourceRevision, 'build', 'leased', {
      acceptSeq,
      leasedAt: new Date().toISOString(),
    })
    return queue.dispatchBuild(name, { kind, sourceRevision, acceptSeq, daemonId, basedOnRevision })
  }

  async function projectHeadChanged(name, head) {
    acceptedHeads.set(name, head)
    return queue.projectHeadChanged(name, head)
  }

  return { ...queue, dispatchBuild, projectHeadChanged }
}

// The server always forks the local worker. Only real queue settings remain
// configurable in server.yaml.
const _config = loadServerConfig()
const _default = createDispatcherWithOptions(ForkTransport, {
  maxConcurrency: _config.buildMaxConcurrency,
  priority: _config.buildPriority,
})

export const { dispatchBuild, projectHeadChanged, killBuild, killAllDispatchedBuilds, isBuilding, isBuildKindPending } = _default

export async function resumeDurableBuildIntents({ dispatch = dispatchBuild, headChanged = projectHeadChanged } = {}) {
  const resumed = []
  for (const project of await listProjects()) {
    const lifecycle = await sourceLifecycleStore(project.name)
    const authority = await lifecycle.readAuthority()
    await headChanged(project.name, authority.currentRevision || null)
    for (const revision of lifecycle.listRevisionLifecycles(project.name)) {
      if (!['pending', 'leased'].includes(revision.build?.state)) continue
      const submission = revision.queueSubmission
      if (!submission?.daemonId || !Object.prototype.hasOwnProperty.call(submission, 'basedOnRevision')) {
        throw new Error(`cannot resume ${project.name}@${revision.sourceRevision}: durable queue submission identity is missing`)
      }
      resumed.push({ project: project.name, sourceRevision: revision.sourceRevision, acceptSeq: revision.acceptSeq })
      void dispatch(project.name, {
        sourceRevision: revision.sourceRevision,
        acceptSeq: revision.acceptSeq,
        daemonId: submission.daemonId,
        basedOnRevision: submission.basedOnRevision,
      }).catch(error => {
        recordBuildResult(project.name, revision.sourceRevision, revision.acceptSeq, 'build_failed', {
          error: error?.message || String(error),
          resumed: true,
        }).catch(recordError => {
          console.error(`[build-dispatch] resumed build disposition failed for ${project.name}: ${recordError.message}`)
        })
      })
    }
  }
  return resumed
}
