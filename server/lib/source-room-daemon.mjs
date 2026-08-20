import { createHash, randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import * as Y from 'yjs'

const SERVER_ORIGIN = Symbol('tlda-source-room-server')
const CLIENT_ORIGIN = Symbol('tlda-source-room-client')
const SOURCE_ROOM_DAEMON_PREFIX = 'source-room'
const MAX_RETRY_DELAY_MS = 30_000

function syncFile(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, content)
  syncFile(pending)
  renameSync(pending, path)
  syncFile(path)
  syncFile(dirname(path))
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function atomicJson(path, value) {
  atomicWrite(path, JSON.stringify(value, null, 2))
}

function encodedPath(path) {
  return encodeURIComponent(path).replaceAll('%', '~')
}

function bufferFromBase64(value) {
  return Buffer.from(String(value || ''), 'base64')
}

async function sourceRoomFileText(lifecycle, { revisionId = null, filePath }) {
  const content = revisionId
    ? await lifecycle.readRevisionFile(revisionId, filePath)
    : (await lifecycle.readCurrentFile(filePath))?.content
  return content ? content.toString('utf8') : ''
}

function hasConflictMarkers(text) {
  return text.includes('<<<<<<<') || text.includes('=======') || text.includes('>>>>>>>')
}

function mergeText({ base, current, incoming, project, filePath }) {
  const dir = join(tmpdir(), `tlda-source-room-${process.pid}-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  try {
    const paths = ['current', 'base', 'incoming'].map(name => join(dir, name))
    writeFileSync(paths[0], current)
    writeFileSync(paths[1], base)
    writeFileSync(paths[2], incoming)
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '-p',
        '-L',
        `live room for ${project}:${filePath}`,
        '-L',
        'previous accepted source',
        '-L',
        `accepted server source for ${project}:${filePath}`,
        '--',
        ...paths,
      ],
      { encoding: 'utf8' },
    )
    if (result.status === 0) return { ok: true, text: result.stdout, conflicted: false }
    if (result.status === 1 && result.stdout.includes('<<<<<<<')) {
      return { ok: true, text: result.stdout, conflicted: true }
    }
    return { ok: false, error: result.stderr || `git merge-file exited ${result.status}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function replaceYText(ytext, text) {
  ytext.doc?.transact(() => {
    ytext.delete(0, ytext.length)
    ytext.insert(0, text)
  }, SERVER_ORIGIN)
}

function sendJson(ws, value) {
  if (ws.readyState !== 1) return false
  ws.send(JSON.stringify(value))
  return true
}

export function sourceRoomDaemonKey(project) {
  return `${SOURCE_ROOM_DAEMON_PREFIX}:${project}`
}

export function createSourceRoomDaemon({
  projectDir,
  readProject,
  sourceLifecycleStore,
  readClientSourceManifest,
  gitSyncManagerForProject,
  // How the room says it is holding an edit that never reached the paper, and
  // that it has stopped. Injected like everything else this file touches: the
  // room tests stand up their own project store, so importing the real
  // recorder would write these into a different store than the one under test
  // and report nothing while looking wired.
  recordHeldEdit = null,
  clearHeldEdit = null,
  pushDelayMs = 250,
  log = console,
}) {
  if (typeof gitSyncManagerForProject !== 'function') {
    throw new Error('createSourceRoomDaemon requires gitSyncManagerForProject')
  }

  const rooms = new Map()

  function roomKey(project, filePath) {
    return `${project}\0${filePath}`
  }

  function roomPaths(project, filePath) {
    const root = join(projectDir(project), '.source-room')
    const encoded = encodedPath(filePath)
    return {
      root,
      state: join(root, 'state', `${encoded}.json`),
      snapshot: join(root, 'rooms', `${encoded}.json`),
      yjs: join(root, 'yjs', `${encoded}.bin`),
      working: join(root, 'working', filePath),
    }
  }

  async function createRoom(project, filePath) {
    const paths = roomPaths(project, filePath)
    const projectRecord = await readProject(project)
    const gitSync = gitSyncManagerForProject(project)
    gitSync.bindSource(project, join(paths.root, 'working'), { mainFile: projectRecord?.mainFile || null })
    await gitSync.sync(projectRecord ? [projectRecord] : [])
    const snapshot = readJson(paths.snapshot)
    const state = snapshot || readJson(paths.state) || {}
    const lifecycle = await sourceLifecycleStore(project)
    const currentRevision = await (await lifecycle.gitRepository()).head(project)
    if (currentRevision) await gitSync.headChanged(project, currentRevision)
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('source')
    if (typeof snapshot?.yjs === 'string') {
      Y.applyUpdate(ydoc, new Uint8Array(Buffer.from(snapshot.yjs, 'base64')), SERVER_ORIGIN)
    } else if (existsSync(paths.yjs)) {
      Y.applyUpdate(ydoc, new Uint8Array(readFileSync(paths.yjs)), SERVER_ORIGIN)
    } else {
      const text = await sourceRoomFileText(lifecycle, { filePath })
      ytext.insert(0, text)
      atomicWrite(paths.yjs, Buffer.from(Y.encodeStateAsUpdate(ydoc)))
      atomicWrite(paths.working, text)
    }
    const room = {
      project,
      filePath,
      paths,
      ydoc,
      ytext,
      clients: new Set(),
      heldRevision: state.heldRevision || currentRevision || null,
      sourceManifest: Array.isArray(state.sourceManifest) ? state.sourceManifest : null,
      submission: state.submission || null,
      queued: state.submission?.state === 'dirty',
      blocked: Boolean(state.blocked),
      timer: null,
    }
    ydoc.on('update', (update, origin) => {
      persistRoom(room)
      broadcast(room, { type: 'update', update: Buffer.from(update).toString('base64') })
      if (origin === SERVER_ORIGIN) return
      noteLocalChange(room)
    })
    persistRoom(room)
    recoverSubmission(room)
    return room
  }

  async function getRoom(project, filePath) {
    const key = roomKey(project, filePath)
    let room = rooms.get(key)
    if (!room) {
      room = await createRoom(project, filePath)
      rooms.set(key, room)
    }
    return room
  }

  function persistRoom(room) {
    const yjs = Buffer.from(Y.encodeStateAsUpdate(room.ydoc))
    const working = room.ytext.toString()
    const state = {
      version: 2,
      heldRevision: room.heldRevision,
      sourceManifest: room.sourceManifest,
      blocked: room.blocked,
      submission: room.submission,
      yjs: yjs.toString('base64'),
      working,
      updatedAt: new Date().toISOString(),
    }
    // This snapshot is the canonical room record. The yjs/working/state files
    // remain readable projections for existing tools and older room records.
    atomicJson(room.paths.snapshot, state)
    atomicWrite(room.paths.yjs, yjs)
    atomicWrite(room.paths.working, working)
    atomicJson(room.paths.state, state)
  }

  function broadcast(room, message, except = null) {
    for (const client of room.clients) {
      if (client === except) continue
      sendJson(client, message)
    }
  }

  function noteLocalChange(room) {
    room.blocked = hasConflictMarkers(room.ytext.toString())
    if (room.blocked) {
      persistRoom(room)
      return
    }
    room.queued = true
    if (!room.submission) room.submission = newSubmission(room)
    if (room.submission.state === 'submitting' || room.submission.state === 'retry_wait') {
      persistRoom(room)
      return
    }
    room.submission = newSubmission(room)
    persistRoom(room)
    if (room.timer) clearTimeout(room.timer)
    room.timer = setTimeout(() => {
      room.timer = null
      void flushRoom(room)
    }, pushDelayMs)
  }

  async function sourceManifestFor(room) {
    if (Array.isArray(room.sourceManifest) && room.sourceManifest.includes(room.filePath)) return room.sourceManifest
    const current = await readClientSourceManifest(room.project).catch(() => [])
    return [...new Set([...current, room.filePath])].sort()
  }

  function contentHash(content) {
    return createHash('sha256').update(content).digest('hex')
  }

  function newSubmission(room) {
    const content = room.ytext.toString()
    return {
      requestId: randomUUID(),
      expectedRevision: room.heldRevision,
      contentHash: contentHash(content),
      content,
      sourceManifest: room.sourceManifest,
      state: 'dirty',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
    }
  }

  function retryDelayMs(attempts) {
    return Math.min(MAX_RETRY_DELAY_MS, pushDelayMs * (2 ** Math.max(0, attempts - 1)))
  }

  function armSubmission(room, delayMs) {
    if (room.timer) clearTimeout(room.timer)
    room.timer = setTimeout(() => {
      room.timer = null
      void flushRoom(room)
    }, Math.max(0, delayMs))
  }

  function recoverSubmission(room) {
    const submission = room.submission
    if (!submission || submission.state === 'blocked') return
    if (submission.state === 'submitting') submission.state = 'retry_wait'
    const due = submission.nextAttemptAt ? Date.parse(submission.nextAttemptAt) : Date.now()
    persistRoom(room)
    armSubmission(room, Math.max(0, due - Date.now()))
  }

  /** Record that the room is holding an edit which has not reached authority. */
  async function noteRoomIsHolding(room, reason) {
    if (!recordHeldEdit) return
    try {
      await recordHeldEdit(room.project, {
        owner: { sourceDaemonKey: sourceRoomDaemonKey(room.project), participant: 'the live editor' },
        file: room.filePath,
        files: [room.filePath],
        reason,
      })
    } catch (error) {
      // Recording is an instrument. It must never be the thing that breaks a
      // push path, and least of all one that is already failing.
      log.error?.(`[source-room] ${room.project}:${room.filePath} could not record a held edit: ${error?.message || error}`)
    }
  }

  async function noteRoomIsClear(room) {
    if (!clearHeldEdit) return
    try {
      await clearHeldEdit(room.project, { sourceDaemonKey: sourceRoomDaemonKey(room.project) }, room.filePath)
    } catch (error) {
      log.error?.(`[source-room] ${room.project}:${room.filePath} could not clear a held edit: ${error?.message || error}`)
    }
  }

  async function flushRoom(room) {
    if (room.blocked || room.submission?.state === 'submitting') return
    room.queued = false
    if (!room.submission) room.submission = newSubmission(room)
    const submission = room.submission
    if (submission.state === 'retry_wait' && submission.nextAttemptAt && Date.parse(submission.nextAttemptAt) > Date.now()) {
      armSubmission(room, Date.parse(submission.nextAttemptAt) - Date.now())
      return
    }
    submission.state = 'submitting'
    submission.attempts += 1
    submission.nextAttemptAt = null
    persistRoom(room)
    try {
      const sourceManifest = Array.isArray(submission.sourceManifest)
        ? submission.sourceManifest
        : await sourceManifestFor(room)
      submission.sourceManifest = sourceManifest
      room.sourceManifest = sourceManifest
      persistRoom(room)
      const gitSync = gitSyncManagerForProject(room.project)
      gitSync.queuePaths(room.project, [room.filePath])
      submission.state = 'queued'
      persistRoom(room)
      broadcast(room, { type: 'status', status: 'queued', sourceRevision: room.heldRevision, building: true })
    } catch (error) {
      await scheduleRetry(room, error?.message || String(error))
      broadcast(room, {
        type: 'status',
        status: 'error',
        sourceRevision: room.heldRevision,
        error: error?.message || String(error),
      })
      log.error?.(`[source-room] ${room.project}:${room.filePath} push failed: ${error?.message || error}`)
    }
  }

  async function scheduleRetry(room, error) {
    const submission = room.submission
    if (!submission) return
    const delay = retryDelayMs(submission.attempts)
    submission.state = 'retry_wait'
    submission.lastError = error
    submission.nextAttemptAt = new Date(Date.now() + delay).toISOString()
    room.queued = true
    persistRoom(room)
    armSubmission(room, delay)
    await noteRoomIsHolding(room, error)
  }

  function conflictTextFor(result, filePath) {
    const classifications = result?.evidence?.classifications
    if (!Array.isArray(classifications)) return null
    const match = classifications.find(item => item?.path === filePath && item?.status === 'conflict' && item?.merged)
    return match ? bufferFromBase64(match.merged).toString('utf8') : null
  }

  function isTerminalBlockedResult(result) {
    return [
      'stale-base',
      'recovery-required',
      'invalid-request-id-reuse',
      'overleaf-conflict',
    ].includes(result?.lifecycleStatus)
  }

  async function applyAcceptedSourceMutation(message) {
    if (message?.sourceDaemonKey?.startsWith(SOURCE_ROOM_DAEMON_PREFIX)) return { ok: true, skipped: 'source-room-origin' }
    const changed = [...(message?.files || []).map(file => file?.path), ...(message?.deletedFiles || [])].filter(Boolean)
    const targetRooms = [...rooms.values()].filter(room => room.project === message.project && changed.includes(room.filePath))
    const applied = []
    const conflicted = []
    for (const room of targetRooms) {
      const lifecycle = await sourceLifecycleStore(room.project)
      const file = (message.files || []).find(candidate => candidate?.path === room.filePath)
      const base = await sourceRoomFileText(lifecycle, { revisionId: message.previousRevision, filePath: room.filePath })
      const incoming = file ? bufferFromBase64(file.content).toString('utf8') : ''
      const merged = mergeText({ base, current: room.ytext.toString(), incoming, project: room.project, filePath: room.filePath })
      if (!merged.ok) {
        log.error?.(`[source-room] ${room.project}:${room.filePath} accepted-update merge failed: ${merged.error}`)
        continue
      }
      room.heldRevision = message.sourceRevision || room.heldRevision
      room.sourceManifest = Array.isArray(message.sourceManifest) ? message.sourceManifest : room.sourceManifest
      room.blocked = merged.conflicted
      replaceYText(room.ytext, merged.text)
      persistRoom(room)
      if (merged.conflicted) conflicted.push(room.filePath)
      else applied.push(room.filePath)
      if (!merged.conflicted && room.ytext.toString() !== incoming) noteLocalChange(room)
    }
    return { ok: true, applied, conflicted }
  }

  async function handleSocket(project, filePath, ws) {
    const projectRecord = await readProject(project)
    if (!projectRecord) {
      sendJson(ws, { type: 'error', message: 'Project not found' })
      ws.close()
      return
    }
    const room = await getRoom(project, filePath)
    room.clients.add(ws)
    sendJson(ws, {
      type: 'sync',
      update: Buffer.from(Y.encodeStateAsUpdate(room.ydoc)).toString('base64'),
      sourceRevision: room.heldRevision,
      blocked: room.blocked,
    })
    ws.on('message', data => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message?.type === 'update' && typeof message.update === 'string') {
        Y.applyUpdate(room.ydoc, new Uint8Array(Buffer.from(message.update, 'base64')), CLIENT_ORIGIN)
      } else if (message?.type === 'flush') {
        void flushRoom(room)
      }
    })
    ws.on('close', () => {
      room.clients.delete(ws)
    })
  }

  async function headChanged(project, revision) {
    const result = await gitSyncManagerForProject(project).headChanged(project, revision)
    for (const room of rooms.values()) {
      if (room.project !== project) continue
      room.heldRevision = revision
      room.submission = null
      room.queued = false
      persistRoom(room)
      await noteRoomIsClear(room)
      broadcast(room, { type: 'status', status: 'synced', sourceRevision: revision, building: false })
    }
    return result
  }

  async function submitFiles(project, payload = {}) {
    const projectRecord = await readProject(project)
    if (!projectRecord) return { status: 404, body: { ok: false, error: 'Project not found' } }
    const root = join(projectDir(project), '.source-room', 'working')
    const gitSync = gitSyncManagerForProject(project)
    gitSync.bindSource(project, root, { mainFile: projectRecord.mainFile || null })
    await gitSync.sync([projectRecord])
    const paths = []
    for (const file of payload.files || []) {
      const target = join(root, file.path)
      atomicWrite(target, Buffer.from(file.content || '', file.encoding === 'utf8' ? 'utf8' : 'base64'))
      paths.push(file.path)
    }
    gitSync.queuePaths(project, paths)
    return { status: 202, body: { ok: true, status: 'queued' } }
  }

  return {
    getRoom,
    handleSocket,
    applyAcceptedSourceMutation,
    headChanged,
    submitFiles,
    flushRoom,
    closeAll() {
      for (const room of rooms.values()) {
        if (room.timer) clearTimeout(room.timer)
        room.timer = null
        for (const client of room.clients) {
          try { client.close() } catch {
            // Best-effort cleanup: closeAll is already tearing the room down.
          }
        }
        room.clients.clear()
        room.ydoc.destroy()
      }
      rooms.clear()
    },
  }
}
