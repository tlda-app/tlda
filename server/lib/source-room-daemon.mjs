import { randomUUID } from 'crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'
import * as Y from 'yjs'

const SERVER_ORIGIN = Symbol('tlda-source-room-server')
const CLIENT_ORIGIN = Symbol('tlda-source-room-client')
const SOURCE_ROOM_DAEMON_PREFIX = 'source-room'

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

function fileTextFromSnapshot(revision, filePath) {
  const file = revision?.files?.find(candidate => candidate.path === filePath)
  return file ? bufferFromBase64(file.content).toString('utf8') : ''
}

function sourceRoomFileText(lifecycle, { revisionId = null, filePath }) {
  if (revisionId) return fileTextFromSnapshot(lifecycle.readRevision(revisionId), filePath)
  const current = lifecycle.readCurrentFile(filePath)
  return current?.content ? current.content.toString('utf8') : ''
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
  processProjectPush,
  pushDelayMs = 250,
  log = console,
}) {
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
      yjs: join(root, 'yjs', `${encoded}.bin`),
      working: join(root, 'working', filePath),
    }
  }

  async function createRoom(project, filePath) {
    const paths = roomPaths(project, filePath)
    const state = readJson(paths.state) || {}
    const lifecycle = await sourceLifecycleStore(project)
    const authority = lifecycle.readAuthority()
    const ydoc = new Y.Doc()
    const ytext = ydoc.getText('source')
    if (existsSync(paths.yjs)) {
      Y.applyUpdate(ydoc, new Uint8Array(readFileSync(paths.yjs)), SERVER_ORIGIN)
    } else {
      const text = sourceRoomFileText(lifecycle, { filePath })
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
      pending: null,
      queued: false,
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
    atomicWrite(room.paths.yjs, Buffer.from(Y.encodeStateAsUpdate(room.ydoc)))
    atomicWrite(room.paths.working, room.ytext.toString())
    atomicJson(room.paths.state, {
      version: 1,
      heldRevision: room.heldRevision,
      sourceManifest: room.sourceManifest,
      blocked: room.blocked,
      updatedAt: new Date().toISOString(),
    })
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
    if (room.pending) return
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

  async function flushRoom(room) {
    if (room.pending || room.blocked) return
    room.queued = false
    const content = room.ytext.toString()
    const requestId = randomUUID()
    room.pending = { requestId, content, expectedRevision: room.heldRevision }
    try {
      const sourceManifest = await sourceManifestFor(room)
      room.sourceManifest = sourceManifest
      const result = await processProjectPush(room.project, {
        files: [{ path: room.filePath, content }],
        sourceManifest,
        editedBy: sourceRoomDaemonKey(room.project),
        sourceDaemonKey: sourceRoomDaemonKey(room.project),
        requestId,
        expectedRevision: room.heldRevision,
      })
      if (result.ok) {
        if (typeof result.sourceRevision === 'string') room.heldRevision = result.sourceRevision
        room.pending = null
        room.blocked = hasConflictMarkers(room.ytext.toString())
        persistRoom(room)
        broadcast(room, { type: 'status', status: 'synced', sourceRevision: room.heldRevision, building: Boolean(result.building) })
        if (room.queued || room.ytext.toString() !== content) await flushRoom(room)
        return
      }
      if (result.status === 409 || result.lifecycleStatus === 'stale-base') {
        const merged = conflictTextFor(result, room.filePath)
        if (typeof result.authority?.currentRevision === 'string') room.heldRevision = result.authority.currentRevision
        room.pending = null
        room.blocked = true
        if (merged) replaceYText(room.ytext, merged)
        persistRoom(room)
        broadcast(room, { type: 'status', status: 'conflict', sourceRevision: room.heldRevision })
        return
      }
      throw new Error(result.error || `source room push failed with ${result.status}`)
    } catch (error) {
      room.pending = null
      room.queued = true
      persistRoom(room)
      log.error?.(`[source-room] ${room.project}:${room.filePath} push failed: ${error?.message || error}`)
    }
  }

  function conflictTextFor(result, filePath) {
    const classifications = result?.evidence?.classifications
    if (!Array.isArray(classifications)) return null
    const match = classifications.find(item => item?.path === filePath && item?.status === 'conflict' && item?.merged)
    return match ? bufferFromBase64(match.merged).toString('utf8') : null
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
      const base = sourceRoomFileText(lifecycle, { revisionId: message.previousRevision, filePath: room.filePath })
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
