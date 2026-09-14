#!/usr/bin/env node
/**
 * A build executor: the machine that renders, and nothing else.
 *
 * It accepts one job at a time from the server's remote build transport
 * (`createRemoteTransport` in server/lib/build-transport.mjs), materializes what
 * that job needs on its own disk, and runs `bin/build-worker.mjs` — the SAME
 * worker, forked by the SAME `createForkTransport`, so the render path here is
 * the render path on the app machine rather than a second copy of it that can
 * drift.
 *
 * WHAT IT DELIBERATELY CANNOT DO. It holds no projects directory of the
 * server's, no write credential, and no way to move a head. Its git credential
 * fetches and cannot push (`server/lib/git-http.mjs`). Its account of where its
 * build instance lives is discarded by the transport rather than trusted. Every
 * externally visible effect of a build still happens in the server process,
 * because the worker still ships them there as RPCs — this end only carries the
 * envelopes further.
 *
 * THE WORKSPACE IS A CACHE AND MUST STAY ONE. `<root>/<project>` persists
 * between builds and holds the previous render, the Quarto freeze and the
 * crossref indexes, so a chapter edit does not re-execute a book. It is used
 * only when the revision it was written for is still the server's published
 * head; anything else is discarded and the build runs cold. Deleting the whole
 * directory must produce a correct build, only slower — that is the property
 * that keeps this a cache rather than a second source of truth.
 *
 * AN EXECUTOR HOLDS TWO PIECES OF DURABLE STATE, NOT ONE, and the second is
 * easy to miss because nothing here creates it deliberately. The worker is
 * started with `projectsDir: ROOT`, so `initProjectStore(ROOT)` constructs a
 * `ProjectLifecycleStatusIndex` — a sqlite database — at ROOT level, one level
 * ABOVE the per-project cache this comment names. Its authority is the server;
 * this copy is incidental to the build path rather than something the executor
 * needs.
 *
 * **So the cold-start test deletes ROOT, not `<root>/<project>`.** Deleting only
 * the named cache would leave that index in place and prove a cold start that
 * never happened — a test passing while the state it aimed at survives.
 *
 *   TLDA_BUILD_EXECUTOR_TOKEN   shared secret the transport presents
 *   TLDA_BUILD_EXECUTOR_ROOT    workspace root (default ~/.cache/tlda-build-executor)
 *   TLDA_BUILD_EXECUTOR_PORT    default 7711
 *   TLDA_BUILD_EXECUTOR_HOST    interface to bind (default: every interface)
 *
 * THE BIND ADDRESS IS A DEPLOYMENT PROPERTY, WHICH IS WHY IT IS SETTABLE AND
 * WHY ITS DEFAULT IS THE PERMISSIVE ONE. This process has no transport security
 * of its own: it is plaintext with a bearer token, so its confidentiality is
 * entirely the link's. Across a tailnet that is the accepted posture; on a
 * machine that also joins arbitrary networks it is not, and there the host must
 * be pinned. Defaulting to loopback instead would break the only thing this
 * process exists to do -- be reached from another machine -- so the default
 * stays open and the deployment narrows it.
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createForkTransport } from '../server/lib/build-transport.mjs'
import { tarDirectory, EXECUTOR_PATH_ARGUMENTS, EXECUTOR_PROTOCOL_VERSION } from '../server/lib/build-executor-protocol.mjs'
import { run } from '../server/lib/build-executor-run.mjs'

const TOKEN = process.env.TLDA_BUILD_EXECUTOR_TOKEN || ''
const ROOT = process.env.TLDA_BUILD_EXECUTOR_ROOT || join(homedir(), '.cache', 'tlda-build-executor')
const PORT = Number(process.env.TLDA_BUILD_EXECUTOR_PORT || 7711)
const HOST = process.env.TLDA_BUILD_EXECUTOR_HOST || ''

if (!TOKEN) {
  console.error('[build-executor] TLDA_BUILD_EXECUTOR_TOKEN is required; refusing to run an unauthenticated executor')
  process.exit(1)
}

// What the workspace cache holds, and what the previous build wrote it for.
// The items are exactly the ones `materializeBuildInstance` seeds from, so this
// list and that one are the same set said twice — if they diverge, the seed
// silently stops carrying something and every build gets slower with nothing to
// read about it.
const CACHED_ITEMS = ['output', 'build-cache', '.biber-par-cache', '_freeze', '.quarto/xref', '.quarto/idx', '.quarto/cites']
const SEED_MARKER = '.executor-seed.json'

const instances = new Map()

function readSeedMarker(projectWorkspace) {
  const path = join(projectWorkspace, SEED_MARKER)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

/**
 * Bring the workspace to a state the build can seed from, and say which.
 *
 * The decision is one comparison and it is deliberately not cleverer than that:
 * the cache is usable when it was written for the revision the server currently
 * publishes. Anything else — a first build, a build somewhere else since, a
 * publication that failed after this executor cached its tree — is a cold
 * build, which is correct and slower.
 */
function reconcileCache(projectWorkspace, publishedHead) {
  const marker = readSeedMarker(projectWorkspace)
  if (marker?.revision && publishedHead && marker.revision === publishedHead) {
    return { warm: true, reason: `cache holds ${publishedHead.slice(0, 12)}` }
  }
  for (const item of CACHED_ITEMS) rmSync(join(projectWorkspace, item), { recursive: true, force: true })
  rmSync(join(projectWorkspace, SEED_MARKER), { force: true })
  return {
    warm: false,
    reason: marker?.revision
      ? `cache holds ${marker.revision.slice(0, 12)} but the published head is ${publishedHead ? publishedHead.slice(0, 12) : 'unset'}`
      : 'no cache',
  }
}

/**
 * Take the tree this build produced into the workspace cache.
 *
 * Done while the publish RPC is in flight rather than after it, because the
 * worker removes its instance as soon as the RPC settles. Caching a tree whose
 * publication then fails is harmless: the published head will not be this
 * revision, so `reconcileCache` discards it on the next build. That is the
 * whole reason the cache is keyed on the published head rather than on what
 * this executor believes it did.
 */
function cacheFromInstance(projectWorkspace, instanceProject, revision) {
  for (const item of CACHED_ITEMS) {
    const from = join(instanceProject, item)
    if (!existsSync(from)) continue
    const to = join(projectWorkspace, item)
    rmSync(to, { recursive: true, force: true })
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(from, to, { recursive: true, verbatimSymlinks: true })
  }
  writeFileSync(join(projectWorkspace, SEED_MARKER), JSON.stringify({ version: 1, revision }))
}

async function materializeRevision(projectWorkspace, job) {
  const gitDir = join(projectWorkspace, '.source-lifecycle', 'git')
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true })
    await run('git', ['init', '--bare', '--quiet', gitDir])
  }
  if (!job.git?.url) throw new Error('the job carries no git endpoint, so this executor cannot fetch its revision')
  const remote = new URL(job.git.url)
  remote.username = encodeURIComponent(job.git.daemonId || 'build-executor')
  remote.password = encodeURIComponent(job.git.token || '')
  remote.pathname = `${remote.pathname.replace(/\/$/, '')}/git/${encodeURIComponent(job.name)}`
  // TWO FETCHES, and the second one is not belt-and-braces.
  //
  // The refs first: `head`, `isAncestor` and `diffRevisions` all read refs this
  // build did not name, and without them the render-relevance decision fails
  // into "render everything" on every build — a filter that always says yes,
  // which is the same as no filter.
  //
  // Then the revision ITSELF, by sha, because no ref points at it. Measured:
  // `acceptRevision` writes a commit and no ref, and the revision becomes
  // `refs/tlda/source/<project>` only when the build publishes it. The window a
  // build runs in is exactly the window in which its own revision is
  // unreferenced, so a ref fetch brings everything except the thing being built.
  // The server allows the sha fetch (see `allowFetchBySha` in
  // server/lib/git-http.mjs); a ref is written HERE, locally, so the object has
  // something holding it against this repository's own gc.
  await run('git', ['--git-dir', gitDir, 'fetch', '--quiet', remote.toString(), '+refs/tlda/*:refs/tlda/*'])
  await run('git', [
    '--git-dir', gitDir, 'fetch', '--quiet', remote.toString(),
    `+${job.sourceRevision}:refs/tlda/executor-building/${encodeURIComponent(job.name)}`,
  ])
  const present = await run('git', ['--git-dir', gitDir, 'cat-file', '-t', job.sourceRevision]).catch(() => '')
  if (present.trim() !== 'commit') {
    throw new Error(`fetched ${job.name} from the server but revision ${job.sourceRevision} is not in the result`)
  }
}

function handleJob(socket, frame) {
  const job = frame.job || {}
  const send = payload => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload)) }
  const projectWorkspace = join(ROOT, job.name)
  let handle = null
  const minted = []

  const failFast = error => {
    send({ t: 'executor-error', error: error.message })
    send({ t: 'exit', code: 1, signal: null, output: error.message })
  }

  ;(async () => {
    if (frame.version !== EXECUTOR_PROTOCOL_VERSION) {
      throw new Error(`executor speaks protocol ${EXECUTOR_PROTOCOL_VERSION}, server sent ${frame.version}`)
    }
    if (!job.name || !job.sourceRevision) throw new Error('a job needs a project and a source revision')
    mkdirSync(projectWorkspace, { recursive: true })
    // The project record is the server's, and it arrives with the job rather
    // than being read out of a store this machine does not have.
    writeFileSync(join(projectWorkspace, 'project.json'), JSON.stringify(job.project, null, 2))
    const cache = reconcileCache(projectWorkspace, job.publishedHead)
    await materializeRevision(projectWorkspace, job)
    console.log(`[build-executor] ${job.name} ${job.sourceRevision.slice(0, 12)}: ${cache.warm ? 'warm' : 'cold'} — ${cache.reason}`)
    send({ t: 'accepted', warmCache: cache.warm })

    handle = createForkTransport().start(
      { ...job, projectsDir: ROOT },
      {
        onMessage(message, channel) {
          socket.workerChannel = channel
          const indices = EXECUTOR_PATH_ARGUMENTS[message.m]
          if (message.t === 'rpc' && indices) {
            const instanceProject = (message.a || [])[indices[0]]
            if (instanceProject && existsSync(instanceProject) && statSync(instanceProject).isDirectory()) {
              if (message.m === 'publishBuildInstance') {
                try { cacheFromInstance(projectWorkspace, instanceProject, job.sourceRevision) }
                catch (e) {
                  // Swallowed deliberately, and the build is why: this is a
                  // CACHE write standing between a finished render and the
                  // publish RPC that carries it home. Rethrowing would fail a
                  // build that succeeded, to report that it will have to
                  // re-execute next time. A missing cache costs one cold render
                  // and says so in that build's timings; a lost publish costs
                  // the render itself.
                  //
                  // It cannot leave a WRONG cache behind: the marker is written
                  // LAST, so any failure in here — a failed copy, or the marker
                  // write itself — leaves no marker, and no marker is a cold
                  // build. The next run re-executes rather than thawing a tree
                  // that was never finished.
                  console.error(`[build-executor] ${job.name}: could not cache the produced tree: ${e.message}`)
                }
              }
              const instanceToken = randomUUID()
              instances.set(instanceToken, instanceProject)
              minted.push(instanceToken)
              send({ ...message, instance: { token: instanceToken } })
              return
            }
          }
          send(message)
        },
        onError(error) { send({ t: 'executor-error', error: error.message }) },
        onExit(code, signal, output) {
          for (const instanceToken of minted) instances.delete(instanceToken)
          send({ t: 'exit', code, signal, output })
        },
      },
    )
    socket.buildHandle = handle
  })().catch(failFast)
}

const httpServer = createServer(async (req, res) => {
  const authorized = (req.headers.authorization || '') === `Bearer ${TOKEN}`
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: EXECUTOR_PROTOCOL_VERSION, root: ROOT }))
    return
  }
  if (!authorized) {
    res.writeHead(401).end('executor credential required')
    return
  }
  const instanceMatch = (req.url || '').match(/^\/instance\/([0-9a-f-]+)$/)
  if (instanceMatch) {
    const directory = instances.get(instanceMatch[1])
    if (!directory) {
      res.writeHead(404).end('no such build instance')
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-tar' })
    const stream = tarDirectory(directory)
    stream.on('error', error => {
      console.error(`[build-executor] streaming ${directory} failed: ${error.message}`)
      res.destroy(error)
    })
    stream.pipe(res)
    return
  }
  res.writeHead(404).end('not found')
})

const wss = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (req, socket, head) => {
  if ((req.headers.authorization || '') !== `Bearer ${TOKEN}` || !/^\/build\b/.test(req.url || '')) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})

wss.on('connection', socket => {
  socket.on('message', raw => {
    let frame
    try { frame = JSON.parse(raw.toString('utf8')) } catch { return }
    if (frame.t === 'job') return handleJob(socket, frame)
    if (frame.t === 'cancel') return socket.buildHandle?.cancel?.()
    // Everything else is the server answering the worker, and it goes straight
    // through: this end is a wire, not a participant in the protocol.
    socket.workerChannel?.send?.(frame)
  })
  socket.on('close', () => {
    // A server that went away leaves a render running for nothing. Killing the
    // worker's process group is what the fork transport's `cancel` does, and
    // the reason is the same: a build nobody is waiting for is a machine held.
    socket.buildHandle?.cancel?.()
  })
})

const listenArgs = HOST ? [PORT, HOST] : [PORT]
httpServer.listen(...listenArgs, () => {
  console.log(`[build-executor] listening on ${HOST || 'every interface'}:${PORT}, workspace root ${ROOT}`)
})
