/**
 * TLDraw sync room management using @tldraw/sync.
 *
 * Replaces the hand-rolled Yjs shape sync with TLDraw's native CRDT protocol.
 * Shapes get proper per-property conflict resolution; signals stay in Yjs.
 */

import { TLSocketRoom, InMemorySyncStorage } from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, defaultBindingSchemas, DefaultColorStyle } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'
import { createMigrationSequence } from '@tldraw/store'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// --- Custom shape schemas (prop validators only, no React) ---

const customShapeSchemas = {
  'math-note': {
    props: {
      w: T.number,
      h: T.number,
      text: T.string,
      color: DefaultColorStyle,
      autoSize: T.optional(T.boolean),
      choices: T.optional(T.arrayOf(T.string)),
      selectedChoice: T.optional(T.number),
      tabs: T.optional(T.arrayOf(T.string)),
      activeTab: T.optional(T.number),
      done: T.optional(T.boolean),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.math-note',
      sequence: [],
    }),
  },
  'svg-page': {
    props: {
      w: T.number,
      h: T.number,
      pageIndex: T.number,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.svg-page',
      sequence: [],
    }),
  },
  'html-page': {
    props: {
      w: T.number,
      h: T.number,
      url: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.html-page',
      sequence: [],
    }),
  },
  'svg-figure': {
    props: {
      w: T.number,
      h: T.number,
      svgUrl: T.string,
      parentShapeId: T.string,
      offsetY: T.number,
      caption: T.optional(T.string),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.svg-figure',
      sequence: [],
    }),
  },
}

const schema = createTLSchema({
  bindings: defaultBindingSchemas,
  shapes: {
    ...defaultShapeSchemas,
    ...customShapeSchemas,
  },
})

// --- Room management ---

/** @type {Map<string, TLSocketRoom>} */
const rooms = new Map()

/** @type {string} */
let projectsDir = ''

/** @type {Map<string, Set<(event: object) => void>>} */
const changeListeners = new Map()

/**
 * Initialize the sync rooms module with the projects directory.
 * @param {string} dir - Path to server/projects/ directory
 */
export function initSyncRooms(dir) {
  projectsDir = dir
}

/**
 * Get snapshot file path for a document.
 * Room names use "doc-{project}" convention; strip prefix for storage path.
 */
function snapshotPath(docName) {
  const projectName = docName.startsWith('doc-') ? docName.slice(4) : docName
  return join(projectsDir, projectName, 'sync-snapshot.json')
}

/**
 * Load a room snapshot from disk if it exists.
 */
function loadSnapshot(docName) {
  const path = snapshotPath(docName)
  if (!existsSync(path)) return null
  try {
    const data = readFileSync(path, 'utf-8')
    return JSON.parse(data)
  } catch (e) {
    console.error(`[sync] Failed to load snapshot for ${docName}:`, e.message)
    return null
  }
}

/**
 * Save a room snapshot to disk (atomic write).
 */
function saveSnapshot(docName, room) {
  const path = snapshotPath(docName)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const snapshot = room.getCurrentSnapshot()
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(snapshot))
  renameSync(tmp, path)
}

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const saveTimers = new Map()

/**
 * Schedule a debounced snapshot save.
 */
function scheduleSave(docName, room) {
  if (saveTimers.has(docName)) clearTimeout(saveTimers.get(docName))
  saveTimers.set(docName, setTimeout(() => {
    saveTimers.delete(docName)
    try {
      saveSnapshot(docName, room)
    } catch (e) {
      console.error(`[sync] Failed to save snapshot for ${docName}:`, e.message)
    }
  }, 2000))
}

/**
 * Notify change listeners for a document.
 */
function notifyChangeListeners(docName) {
  const listeners = changeListeners.get(docName)
  if (!listeners) return
  for (const cb of listeners) {
    try { cb({ docName, timestamp: Date.now() }) } catch {}
  }
}

// --- Change log: append-only JSONL of shape mutations ---

/** @type {Map<string, Map<string, { state: object, clock: number }>>} */
const prevSnapshots = new Map()

/**
 * Get changelog file path for a document.
 */
function changelogPath(docName) {
  const projectName = docName.startsWith('doc-') ? docName.slice(4) : docName
  return join(projectsDir, projectName, 'changelog.jsonl')
}

/**
 * Build a lookup map from a snapshot's documents array.
 * @param {{ state: object, lastChangedClock: number }[]} docs
 * @returns {Map<string, { state: object, clock: number }>}
 */
function buildDocMap(docs) {
  const m = new Map()
  for (const d of docs) {
    if (d.state?.id) m.set(d.state.id, { state: d.state, clock: d.lastChangedClock })
  }
  return m
}

/**
 * Diff current snapshot against previous, append changes to JSONL log.
 */
function recordChanges(docName, room) {
  const snapshot = room.getCurrentSnapshot()
  const current = buildDocMap(snapshot.documents)
  const prev = prevSnapshots.get(docName)

  // First call for this room: just record baseline, no diff
  if (!prev) {
    prevSnapshots.set(docName, current)
    return
  }

  const entries = []
  const ts = Date.now()

  // Created or updated
  for (const [id, { state, clock }] of current) {
    const old = prev.get(id)
    if (!old) {
      entries.push({ ts, action: 'create', id, type: state.typeName, shapeType: state.type, state })
    } else if (old.clock !== clock) {
      // Only log shape records, skip internal tldraw records (camera, page, instance, etc.)
      const diff = shallowDiff(old.state, state)
      if (diff) {
        entries.push({ ts, action: 'update', id, type: state.typeName, shapeType: state.type, diff })
      }
    }
  }

  // Deleted
  for (const [id, { state }] of prev) {
    if (!current.has(id)) {
      entries.push({ ts, action: 'delete', id, type: state.typeName, shapeType: state.type })
    }
  }

  prevSnapshots.set(docName, current)

  if (entries.length === 0) return

  // Filter to interesting records (shapes, not camera/pointer/instance state)
  const interesting = entries.filter(e =>
    e.type === 'shape' || e.action === 'delete'
  )
  if (interesting.length === 0) return

  const path = changelogPath(docName)
  const lines = interesting.map(e => JSON.stringify(e)).join('\n') + '\n'
  try {
    appendFileSync(path, lines)
  } catch (e) {
    console.error(`[changelog] Failed to write ${path}:`, e.message)
  }
}

/**
 * Shallow diff two record states. Returns changed fields or null if identical.
 */
function shallowDiff(a, b) {
  const diff = {}
  let changed = false
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key], bv = b[key]
    if (av === bv) continue
    // Deep compare for objects (props, meta)
    if (typeof av === 'object' && typeof bv === 'object' && av !== null && bv !== null) {
      if (JSON.stringify(av) === JSON.stringify(bv)) continue
    }
    diff[key] = { from: av, to: bv }
    changed = true
  }
  return changed ? diff : null
}

/**
 * Get or create a TLSocketRoom for a document.
 * @param {string} docName
 * @returns {TLSocketRoom}
 */
export function getOrCreateRoom(docName) {
  if (rooms.has(docName)) return rooms.get(docName)

  const snapshot = loadSnapshot(docName)
  const opts = {
    schema,
    onDataChange: () => {
      scheduleSave(docName, room)
      recordChanges(docName, room)
      notifyChangeListeners(docName)
    },
  }
  if (snapshot) {
    opts.initialSnapshot = snapshot
    // Seed changelog baseline from loaded snapshot
    prevSnapshots.set(docName, buildDocMap(snapshot.documents))
  }

  const room = new TLSocketRoom(opts)
  rooms.set(docName, room)
  console.log(`[sync] Room created: ${docName}${snapshot ? ' (loaded snapshot)' : ''}`)
  return room
}

/**
 * Subscribe to shape changes for a document. Returns unsubscribe function.
 * @param {string} docName
 * @param {(event: object) => void} callback
 * @returns {() => void}
 */
export function onShapeChange(docName, callback) {
  if (!changeListeners.has(docName)) changeListeners.set(docName, new Set())
  changeListeners.get(docName).add(callback)
  return () => changeListeners.get(docName)?.delete(callback)
}

/**
 * Get all records from a room (for REST API).
 * @param {string} docName
 * @param {string} [typeFilter] - Optional shape type filter (e.g., 'math-note')
 * @returns {object[]}
 */
export function getRoomRecords(docName, typeFilter) {
  const room = getOrCreateRoom(docName)

  const snapshot = room.getCurrentSnapshot()
  let records = snapshot.documents.map(d => d.state)

  if (typeFilter) {
    const types = new Set(typeFilter.split(','))
    records = records.filter(r => r.typeName === 'shape' && types.has(r.type))
  }

  return records
}

/**
 * Atomically update a shape in a room (for REST API).
 * @param {string} docName
 * @param {object} shape - Full shape record to put
 */
export async function putShape(docName, shape) {
  const room = getOrCreateRoom(docName)
  // Use storage.transaction directly — updateStore is deprecated and doesn't trigger
  // broadcastExternalStorageChanges (it writes without the internal txn id but doesn't
  // go through the onChange path reliably). storage.transaction() fires onChange which
  // triggers broadcastPatch to all connected sessions.
  room.storage.transaction((txn) => {
    txn.set(shape.id, shape)
  })
}

/**
 * Atomically update specific fields of a shape (read-modify-write).
 * @param {string} docName
 * @param {string} shapeId
 * @param {(shape: object) => object} updater - Takes current shape, returns updated shape
 */
export async function updateShape(docName, shapeId, updater) {
  const room = getOrCreateRoom(docName)
  room.storage.transaction((txn) => {
    const current = txn.get(shapeId)
    if (!current) throw new Error(`Shape not found: ${shapeId}`)
    const updated = updater(current)
    txn.set(shapeId, updated)
  })
}

/**
 * Get a single record from a room by ID.
 * @param {string} docName
 * @param {string} recordId
 * @returns {object|null}
 */
export function getRecord(docName, recordId) {
  const room = getOrCreateRoom(docName)
  return room.getRecord(recordId) ?? null
}

// --- Signal cache + listeners ---

/** @type {Map<string, Map<string, object>>} docName → (signalKey → {key, ...data, timestamp}) */
const signalCache = new Map()

/** @type {Map<string, Set<(signal: object) => void>>} */
const signalListeners = new Map()

/**
 * Broadcast a custom message to all connected sessions in a room.
 * Also caches the signal for replay to reconnecting clients.
 * @param {string} docName
 * @param {string} key - Signal key (e.g., 'signal:reload')
 * @param {object} data - Signal payload
 */
export function broadcastSignal(docName, key, data) {
  const message = { key, ...data, timestamp: data.timestamp || Date.now() }

  // Cache for replay on reconnect
  if (!signalCache.has(docName)) signalCache.set(docName, new Map())
  signalCache.get(docName).set(key, message)

  // Notify signal listeners (SSE streams, MCP observers)
  const listeners = signalListeners.get(docName)
  if (listeners) {
    for (const cb of listeners) {
      try { cb(message) } catch {}
    }
  }

  const room = rooms.get(docName)
  if (!room) return
  for (const session of room.getSessions()) {
    if (session.isConnected) {
      room.sendCustomMessage(session.sessionId, message)
    }
  }
}

/**
 * Read the last cached value of a signal (for REST/MCP access).
 * @param {string} docName
 * @param {string} key
 * @returns {object|null}
 */
export function getLastSignal(docName, key) {
  return signalCache.get(docName)?.get(key) ?? null
}

/**
 * Subscribe to signal broadcasts for a document. Returns unsubscribe function.
 * @param {string} docName
 * @param {(signal: object) => void} callback - Called with {key, ...data, timestamp}
 * @returns {() => void}
 */
export function onSignal(docName, callback) {
  if (!signalListeners.has(docName)) signalListeners.set(docName, new Set())
  signalListeners.get(docName).add(callback)
  return () => signalListeners.get(docName)?.delete(callback)
}

/** Signal keys and their replay windows (ms). Only these get replayed on connect. */
const REPLAY_SIGNALS = {
  'signal:build-status': 600_000,       // 10 min
  'signal:build-progress': 300_000,     // 5 min
  'signal:agent-heartbeat': 30_000,     // 30s
  'signal:diff-review': 86_400_000,     // 24h
  'signal:diff-summaries': 86_400_000,  // 24h
  'signal:viewport': 300_000,           // 5 min (for watcher priority rebuild)
}

/**
 * Send cached signals to a newly connected session.
 * Call right after handleSocketConnect.
 * @param {string} docName
 * @param {string} sessionId
 */
export function replayCachedSignals(docName, sessionId) {
  const cache = signalCache.get(docName)
  if (!cache) return
  const room = rooms.get(docName)
  if (!room) return

  const now = Date.now()
  for (const [key, maxAge] of Object.entries(REPLAY_SIGNALS)) {
    const cached = cache.get(key)
    if (cached && (now - (cached.timestamp || 0)) < maxAge) {
      try {
        room.sendCustomMessage(sessionId, cached)
      } catch {}
    }
  }
}

/**
 * Delete a shape from a room.
 * @param {string} docName
 * @param {string} shapeId
 */
export async function deleteShape(docName, shapeId) {
  const room = getOrCreateRoom(docName)
  room.storage.transaction((txn) => {
    txn.delete(shapeId)
  })
}

/**
 * Flush all pending saves (for graceful shutdown).
 */
export function flushAllRooms() {
  for (const [docName, timer] of saveTimers) {
    clearTimeout(timer)
    saveTimers.delete(docName)
    const room = rooms.get(docName)
    if (room) {
      try {
        saveSnapshot(docName, room)
        console.log(`[sync] Flushed snapshot: ${docName}`)
      } catch (e) {
        console.error(`[sync] Failed to flush ${docName}:`, e.message)
      }
    }
  }
}

/**
 * Close all rooms (for graceful shutdown).
 */
export function closeAllRooms() {
  flushAllRooms()
  for (const [docName, room] of rooms) {
    room.close()
    console.log(`[sync] Room closed: ${docName}`)
  }
  rooms.clear()
}
