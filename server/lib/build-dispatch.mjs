import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { broadcastSignal, putShape, updateShape, emitGlobalEvent } from './sync-rooms.mjs'
import { updateProject, getProjectsDir, listProjects, aggregateBookToc, sourceLifecycleStore, projectDir } from './project-store.mjs'
import { writeSentinel } from './sentinel.mjs'
import { loadServerConfig } from '../../shared/config.mjs'
import { ForkTransport } from './build-transport.mjs'
import { createBuildQueue } from './build-queue.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { listProposalRefs } from './git-proposals.mjs'

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

const SINKS = { broadcastSignal, putShape, patchShape, writeSentinel, emitGlobalEvent, updateProject, regenerateBookTocs }
const publicationLocks = new Map()

function serializedPublication(name, operation) {
  const previous = publicationLocks.get(name) || Promise.resolve()
  const current = previous.then(operation, operation)
  const tracked = current.finally(() => {
    if (publicationLocks.get(name) === tracked) publicationLocks.delete(name)
  })
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

export async function publishBuildInstance(name, sourceRevision, _acceptSeq, instanceProject, reports = [], reportSinks = SINKS) {
  return serializedPublication(name, async () => {
    const lifecycle = await sourceLifecycleStore(name)
    const git = await lifecycle.gitRepository()
    const expectedHead = await git.head(name)
    if (expectedHead && !await git.isAncestor(expectedHead, sourceRevision)) {
      return { published: false, stale: true, sourceRevision, currentHead: expectedHead }
    }

    const liveProject = projectDir(name)
    const transaction = join(liveProject, `.build-publish-${randomUUID()}`)
    const stagedOutput = join(transaction, 'new-output')
    const stagedCache = join(transaction, 'new-build-cache')
    mkdirSync(transaction, { recursive: true })
    cpSync(join(instanceProject, 'output'), stagedOutput, { recursive: true })
    if (existsSync(join(instanceProject, 'build-cache'))) cpSync(join(instanceProject, 'build-cache'), stagedCache, { recursive: true })
    for (const file of ['build.log', 'latex.log']) {
      if (existsSync(join(instanceProject, file))) cpSync(join(instanceProject, file), join(transaction, `new-${file}`))
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
      for (const item of ['output', 'build-cache', 'build.log', 'latex.log']) {
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
        if (['publishBuildInstance', 'recordBuildResult', 'recordRevisionPhase', 'mirrorShadow'].includes(report.method)) continue
        const sink = reportSinks[report.method]
        if (sink) await sink(...(report.args || []))
      }
      return { published: true, sourceRevision, previousHead: expectedHead }
    } catch (error) {
      if (!headMoved) {
        for (const item of ['output', 'build-cache', 'build.log', 'latex.log']) {
          restoreAside(join(liveProject, item), old[item])
        }
      }
      throw error
    } finally {
      // A process crash leaves this directory and its marker. Startup recovery
      // uses the Git ref to choose the only honest side before removing it.
      rmSync(transaction, { recursive: true, force: true })
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
        for (const item of ['output', 'build-cache', 'build.log', 'latex.log']) {
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
    async getCurrentHead(name) {
      return (await (await sourceLifecycleStore(name)).gitRepository()).head(name)
    },
    async isAncestor(ancestor, descendant, name) {
      return (await sourceLifecycleStore(name)).isAncestor(ancestor, descendant)
    },
    random: options.random || Math.random,
    async relayMessage(name, message, job) {
      if (message?.t === 'report') return null
      if (message?.t !== 'rpc') return null
      if (message.m === 'recordBuildResult' || message.m === 'recordRevisionPhase') return null
      if (message.m === 'publishBuildInstance') {
        const result = await publishBuildInstance(...(message.a || []), sinks)
        if (!result.published) throw new Error(`stale build ${job.sourceRevision} cannot publish over ${result.currentHead || 'no head'}`)
        await queue.publishedHeadChanged(name, job.sourceRevision)
        await options.notifyHeadChanged?.(name, job.sourceRevision)
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
    storePath: join(getProjectsDir(), '.build-queue.sqlite'),
    notifyHeadChanged: (...args) => headNotifier?.(...args),
  })
  return activeDispatcher
}

function dispatcher() { return activeDispatcher || initBuildDispatcher() }

export const admitProposal = submission => dispatcher().admitBuild(submission.project, submission)
export const killBuild = name => dispatcher().killBuild(name)
export const killAllDispatchedBuilds = () => dispatcher().killAllDispatchedBuilds()
export const isBuilding = name => dispatcher().isBuilding(name)
export const isBuildKindPending = (name, kind) => dispatcher().isBuildKindPending(name, kind)

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
