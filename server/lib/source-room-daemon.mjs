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
  acceptSourceSnapshot,
  dispatchBuild = null,
  projectHeadChanged = null,
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
  // **Loud, because the rename makes an old stub inert rather than wrong.**
  // This used to take `processProjectPush`, and every caller that still passes
  // that key would otherwise hand over a stub nothing reads — the room would
  // fall through to whatever the real accept does, against a store the test
  // never set up, while the test looked wired. That is the reconstruction
  // hazard this repo names: a dependency assembled from named keys silently
  // drops the one nobody renamed.
  if (typeof acceptSourceSnapshot !== 'function') {
    throw new Error('createSourceRoomDaemon requires acceptSourceSnapshot (it previously took processProjectPush)')
  }

  async function submitSnapshot(project, payload, options = {}) {
    if (payload?.expectedRevision === undefined) {
      const lifecycle = await sourceLifecycleStore(project)
      const authority = await lifecycle.readAuthority()
      payload = { ...payload, expectedRevision: authority.currentRevision || null }
    }
    return acceptSourceSnapshot(project, payload, {
      ...options,
      daemonId: sourceRoomDaemonKey(project),
    })
  }

  async function requestBuild(project, { kind = 'build' } = {}) {
    if (typeof dispatchBuild !== 'function' || typeof projectHeadChanged !== 'function') {
      throw new Error('source-room daemon build submission is not configured')
    }
    const lifecycle = await sourceLifecycleStore(project)
    const authority = await lifecycle.readAuthority()
    const sourceRevision = authority.currentRevision || null
    if (!sourceRevision) throw new Error(`project ${project} has no accepted source revision to build`)
    const revision = lifecycle.readRevisionLifecycle(project, sourceRevision)
    await projectHeadChanged(project, sourceRevision)
    return dispatchBuild(project, {
      kind,
      sourceRevision,
      acceptSeq: revision?.acceptSeq ?? authority.acceptSeq ?? null,
      basedOnRevision: sourceRevision,
      daemonId: sourceRoomDaemonKey(project),
    })
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
    const snapshot = readJson(paths.snapshot)
    const state = snapshot || readJson(paths.state) || {}
    const lifecycle = await sourceLifecycleStore(project)
    const authority = await lifecycle.readAuthority()
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
      heldRevision: state.heldRevision || authority.currentRevision || null,
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
      // The room runs in-process with the lifecycle store, so it calls the
      // accept directly rather than manufacturing a request for the server to
      // send itself. It sends ONE file with a whole-project manifest; the
      // accept carries every other path forward by reference, which is what
      // makes a per-keystroke checkpoint cost one blob instead of the project.
      const response = await acceptSourceSnapshot(room.project, {
        files: [{ path: room.filePath, content: submission.content }],
        sourceManifest,
        editedBy: sourceRoomDaemonKey(room.project),
        // **The echo guard.** `applyAcceptedSourceMutation` skips a message
        // whose origin is a source room, so the room does not re-apply its own
        // edit to itself. The fan-out only sees that origin if the accept
        // carries it, and dropping this field in the repoint would have fed the
        // room's own checkpoint straight back into the room.
        sourceDaemonKey: sourceRoomDaemonKey(room.project),
        requestId: submission.requestId,
        expectedRevision: submission.expectedRevision,
      }, { daemonId: sourceRoomDaemonKey(room.project) })
      // Named rather than spread wholesale: the branches below read
      // `lifecycleStatus`, `authority.currentRevision` and `status`-as-HTTP,
      // and the new shape spells the first two differently. Mapping them here
      // keeps the conflict handling -- which is what puts merge markers in
      // front of the person -- reading the fields it was written against.
      const result = {
        ...response.body,
        status: response.status,
        lifecycleStatus: response.body.status ?? null,
        authority: { currentRevision: response.body.currentRevision ?? response.body.sourceRevision ?? null },
      }
      if (result.ok) {
        if (typeof result.sourceRevision === 'string') room.heldRevision = result.sourceRevision
        room.submission = null
        room.blocked = hasConflictMarkers(room.ytext.toString())
        persistRoom(room)
        await noteRoomIsClear(room)
        broadcast(room, { type: 'status', status: 'synced', sourceRevision: room.heldRevision, building: Boolean(result.building) })
        if (room.queued || room.ytext.toString() !== submission.content) {
          room.submission = newSubmission(room)
          persistRoom(room)
          await flushRoom(room)
        }
        return
      }
      const merged = conflictTextFor(result, room.filePath)
      if (isTerminalBlockedResult(result) || merged) {
        if (typeof result.authority?.currentRevision === 'string') room.heldRevision = result.authority.currentRevision
        submission.state = 'blocked'
        submission.lastError = result.error || 'source conflict'
        room.blocked = true
        if (merged) replaceYText(room.ytext, merged)
        persistRoom(room)
        await noteRoomIsHolding(room, submission.lastError)
        broadcast(room, {
          type: 'status',
          status: merged || result.lifecycleStatus === 'stale-base' ? 'conflict' : 'blocked',
          sourceRevision: room.heldRevision,
          error: submission.lastError,
        })
        return
      }
      await scheduleRetry(room, result.error || `source room push failed with ${result.status}`)
      broadcast(room, {
        type: 'status',
        status: 'error',
        sourceRevision: room.heldRevision,
        error: result.error || `source room push failed with ${result.status}`,
      })
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

  return {
    getRoom,
    handleSocket,
    submitSnapshot,
    requestBuild,
    applyAcceptedSourceMutation,
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
