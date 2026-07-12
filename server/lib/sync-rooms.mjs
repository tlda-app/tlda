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
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { emitShapeChangedDebounced } from './webhooks.mjs'
import { mathNoteProps } from '../../shared/shapes/math-note-schema.mjs'
import { outlineProps } from '../../shared/shapes/outline-schema.mjs'
import { graphNodeProps, graphExplainProps } from '../../shared/shapes/graph-node-schema.mjs'
import {
  fleetAgentsProps,
  fleetChatProps,
  fleetDocviewProps,
  fleetInboxProps,
  fleetNotificationsProps,
  fleetSearchProps,
  fleetSourceEditorProps,
  fleetTouchInboxProps,
} from '../../shared/shapes/fleet-panel-schema.mjs'
import { SIGNAL_REPLAY_WINDOWS } from '../../shared/signals.ts'

// --- Custom shape schemas (prop validators only, no React) ---
// Props that must mirror the client shape util exactly are imported from
// shared/shapes/*-schema.mjs so the two sides can't drift (a mismatch is a
// TLSyncError that crashes the room). Shapes still declared inline here have
// not yet been extracted.

const customShapeSchemas = {
  'math-note': {
    props: mathNoteProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.math-note',
      sequence: [],
    }),
  },
  'outline': {
    props: outlineProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.outline',
      sequence: [],
    }),
  },
  'graph-node': {
    props: graphNodeProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.graph-node',
      sequence: [],
    }),
  },
  'graph-explain': {
    props: graphExplainProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.graph-explain',
      sequence: [],
    }),
  },
  'svg-page': {
    props: {
      w: T.number,
      h: T.number,
      pageIndex: T.number,
      version: T.optional(T.number),
      compareRef: T.optional(T.string),
      compareHash7: T.optional(T.string),
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
      source: T.optional(T.string),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.html-page',
      sequence: [],
    }),
  },
  'toc-drop-target': {
    props: {
      w: T.number,
      h: T.number,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.toc-drop-target',
      sequence: [],
    }),
  },
  'understanding-line': {
    props: {
      w: T.number,
      h: T.number,
      segments: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.understanding-line',
      sequence: [],
    }),
  },
  'reading-assist-bar': {
    props: {
      w: T.number,
      h: T.number,
      highlightId: T.string,
      responseId: T.string,
      color: DefaultColorStyle,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.reading-assist-bar',
      sequence: [],
    }),
  },
  'timeline-overlay': {
    props: {
      w: T.number,
      h: T.number,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.timeline-overlay',
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
      group: T.optional(T.string),
      figureIdx: T.optional(T.number),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.svg-figure',
      sequence: [],
    }),
  },
  'zoomable-image': {
    props: {
      w: T.number,
      h: T.number,
      src: T.string,
      imageW: T.number,
      imageH: T.number,
      cameraGroup: T.optional(T.string),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.zoomable-image',
      sequence: [],
    }),
  },
  'dot-annotation': {
    props: {
      w: T.number,
      h: T.number,
      highlightColor: T.string,
      text: T.string,
      collapsed: T.boolean,
      highlightId: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.dot-annotation',
      sequence: [],
    }),
  },
  'fleet-chat': {
    props: fleetChatProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-chat',
      sequence: [],
    }),
  },
  'fleet-agents': {
    props: fleetAgentsProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-agents',
      sequence: [],
    }),
  },
  'fleet-pill': {
    props: {
      w: T.number,
      h: T.number,
      pillType: T.string,
      value: T.string,
      displayName: T.string,
      color: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-pill',
      sequence: [],
    }),
  },
  'fleet-search': {
    props: fleetSearchProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-search',
      sequence: [],
    }),
  },
  'fleet-inbox': {
    props: fleetInboxProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-inbox',
      sequence: [],
    }),
  },
  'fleet-notifications': {
    props: fleetNotificationsProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-notifications',
      sequence: [],
    }),
  },
  'fleet-touch-inbox': {
    props: fleetTouchInboxProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-touch-inbox',
      sequence: [],
    }),
  },
  'fleet-docview': {
    props: fleetDocviewProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-docview',
      sequence: [],
    }),
  },
  'fleet-source-editor': {
    props: fleetSourceEditorProps,
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-source-editor',
      sequence: [],
    }),
  },
  'fleet-video': {
    props: {
      w: T.number,
      h: T.number,
      tileKeys: T.string,
      userId: T.optional(T.string),
      deviceId: T.optional(T.string),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.fleet-video',
      sequence: [
        {
          id: 'com.tldraw.shape.fleet-video/1',
          scope: 'record',
          filter: (record) => record.typeName === 'shape' && record.type === 'fleet-video',
          up: (record) => {
            const { title: _title, ...props } = record.props
            record.props = props
          },
        },
      ],
    }),
  },
  'doc-clip': {
    props: {
      w: T.number,
      h: T.number,
      page: T.number,
      yTop: T.number,
      yBottom: T.number,
      label: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.doc-clip',
      sequence: [],
    }),
  },
  'inline-doc': {
    props: {
      w: T.number,
      h: T.number,
      url: T.string,
      title: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.inline-doc',
      sequence: [],
    }),
  },
  'doc-version': {
    props: {
      w: T.number,
      h: T.number,
      commitHash: T.string,
      timestamp: T.number,
      buildReadyAt: T.optional(T.number),
      sourceVersion: T.optional(T.number),
      warningsJson: T.optional(T.string),
      errorsJson: T.optional(T.string),
      syncErrorJson: T.optional(T.string),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.doc-version',
      sequence: [],
    }),
  },
  'doc-viewer-state': {
    props: {
      w: T.number,
      h: T.number,
      timestamp: T.number,
      diffReviewJson: T.optional(T.string),
      diffSummariesJson: T.optional(T.string),
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.doc-viewer-state',
      sequence: [],
    }),
  },
  'cluster': {
    props: {
      w: T.number,
      h: T.number,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.cluster',
      sequence: [],
    }),
  },
  'playback-frame': {
    props: {
      w: T.number,
      h: T.number,
      playbackId: T.string,
      mode: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.playback-frame',
      sequence: [],
    }),
  },
  'terminal': {
    props: {
      w: T.number,
      h: T.number,
      agentId: T.string,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.terminal',
      sequence: [],
    }),
  },
  'task-inbox': {
    props: {
      w: T.number,
      h: T.number,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.task-inbox',
      sequence: [],
    }),
  },
  'usage-meter': {
    props: {
      w: T.number,
      h: T.number,
    },
    migrations: createMigrationSequence({
      sequenceId: 'com.tldraw.shape.usage-meter',
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

// Wrap every record type's validate() to log the actual error before TLDraw
// swallows it into a generic INVALID_RECORD session rejection.
for (const [typeName, recordType] of Object.entries(schema.types)) {
  if (typeof recordType.validate === 'function') {
    const originalValidate = recordType.validate.bind(recordType)
    recordType.validate = function loggingValidate(record) {
      try {
        return originalValidate(record)
      } catch (e) {
        console.error(`[sync] SCHEMA VALIDATION FAILED for type "${typeName}":`, e.message)
        console.error(`[sync] Record ID: ${record?.id}, typeName: ${record?.typeName}`)
        if (record?.props) {
          console.error(`[sync] Record props:`, JSON.stringify(record.props, null, 2))
        }
        throw e
      }
    }
  }
}

// --- Room management ---

/** @type {Map<string, TLSocketRoom>} */
const rooms = new Map()

/** Returns all currently active room docNames. */
export function listActiveRooms() {
  return [...rooms.keys()]
}

/** @type {string} */
let projectsDir = ''

/** @type {((failure: object) => void | Promise<void>) | null} */
let signalFailureReporter = null

/** @type {Map<string, Set<(event: object) => void>>} */
const changeListeners = new Map()

/**
 * Initialize the sync rooms module with the projects directory.
 * @param {string} dir - Path to server/projects/ directory
 * @param {{ onSignalFailure?: (failure: object) => void | Promise<void> }} options
 */
export function initSyncRooms(dir, options = {}) {
  projectsDir = dir
  signalFailureReporter = typeof options.onSignalFailure === 'function' ? options.onSignalFailure : null
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
async function loadSnapshot(docName) {
  const path = snapshotPath(docName)
  try {
    const data = await readFile(path, 'utf-8')
    return JSON.parse(data)
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[sync] Failed to load snapshot for ${docName}:`, e.message)
    }
    return null
  }
}

/**
 * Save a room snapshot to disk (atomic write, async to avoid blocking event loop).
 */
async function saveSnapshot(docName, room) {
  const path = snapshotPath(docName)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })

  const snapshot = room.getCurrentSnapshot()
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(snapshot))
  await rename(tmp, path)
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
    saveSnapshot(docName, room)
      .catch(e => console.error(`[sync] Failed to save snapshot for ${docName}:`, e.message))
  }, 2000))
}

/**
 * Notify change listeners for a document.
 * @param {string} docName
 * @param {object[]} [changes] - Optional array of change entries from recordChanges
 */
function notifyChangeListeners(docName, changes) {
  const listeners = changeListeners.get(docName)
  if (!listeners) return
  const event = { docName, timestamp: Date.now() }
  if (changes && changes.length > 0) event.changes = changes
  for (const cb of listeners) {
    try { cb(event) } catch {}
  }
  // Emit webhook to fleet (debounced, annotations fire immediately)
  if (changes && changes.length > 0) {
    emitShapeChangedDebounced(docName, changes)
  }
}

// --- Change log: append-only JSONL of shape mutations ---

/** @type {Map<string, Map<string, { state: object, clock: number }>>} */
const prevSnapshots = new Map()

/** @type {Map<string, number>} */
const prevSnapshotClocks = new Map()

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const changeTimers = new Map()

/**
 * Get changelog file path for a document.
 */
function changelogPath(docName) {
  const projectName = docName.startsWith('doc-') ? docName.slice(4) : docName
  return join(projectsDir, projectName, 'changelog.jsonl.gz')
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
 * Record a whole-snapshot baseline for future delta diffs.
 * @param {string} docName
 * @param {{ documents: { state: object, lastChangedClock: number }[], documentClock?: number }} snapshot
 */
function setChangelogBaseline(docName, snapshot) {
  prevSnapshots.set(docName, buildDocMap(snapshot.documents))
  prevSnapshotClocks.set(docName, snapshot.documentClock ?? 0)
}

/**
 * Read the sync storage's changed-record diff since our previous changelog clock.
 * @param {string} docName
 * @param {TLSocketRoom} room
 * @returns {{ diff: { puts: Record<string, object | [object, object]>, deletes: string[] }, documentClock: number, wipeAll?: boolean } | null}
 */
function getStorageChangesSinceBaseline(docName, room) {
  const sinceClock = prevSnapshotClocks.get(docName)
  if (sinceClock == null || !room.storage?.transaction) return null

  const result = room.storage.transaction((txn) => txn.getChangesSince(sinceClock))
  return result.result ? { ...result.result, documentClock: result.documentClock } : null
}

/**
 * Full-snapshot diff fallback used for first baseline and unusual storage reset cases.
 * @param {string} docName
 * @param {TLSocketRoom} room
 * @returns {object[]|null}
 */
function recordChangesFromSnapshot(docName, room) {
  const snapshot = room.getCurrentSnapshot()
  const current = buildDocMap(snapshot.documents)
  const prev = prevSnapshots.get(docName)

  if (!prev) {
    setChangelogBaseline(docName, snapshot)
    return null
  }

  const entries = []
  const ts = Date.now()

  for (const [id, { state, clock }] of current) {
    const old = prev.get(id)
    if (!old) {
      entries.push({ ts, action: 'create', id, type: state.typeName, shapeType: state.type, state })
    } else if (old.clock !== clock) {
      const diff = shallowDiff(old.state, state)
      if (diff) {
        entries.push({ ts, action: 'update', id, type: state.typeName, shapeType: state.type, diff })
      }
    }
  }

  for (const [id, { state }] of prev) {
    if (!current.has(id)) {
      entries.push({ ts, action: 'delete', id, type: state.typeName, shapeType: state.type })
    }
  }

  prevSnapshots.set(docName, current)
  prevSnapshotClocks.set(docName, snapshot.documentClock ?? 0)

  return writeInterestingChanges(docName, entries)
}

/**
 * Append interesting entries to the changelog and return the notification payload.
 * @param {string} docName
 * @param {object[]} entries
 * @returns {object[]|null}
 */
function writeInterestingChanges(docName, entries) {
  if (entries.length === 0) return null

  // Filter to interesting records (shapes, not camera/pointer/instance state)
  const interesting = entries.filter(e =>
    e.type === 'shape' || e.action === 'delete'
  )
  if (interesting.length === 0) return null

  const path = changelogPath(docName)
  const lines = interesting.map(e => JSON.stringify(e)).join('\n') + '\n'
  const compressed = gzipSync(lines)
  appendFile(path, compressed).catch(e => console.error(`[changelog] Failed to write ${path}:`, e.message))

  return interesting
}

/**
 * Diff changed records against previous, append changes to JSONL log.
 * Returns the interesting changes (shape creates/updates/deletes) for real-time notification.
 * @returns {object[]|null}
 */
function recordChanges(docName, room) {
  const prev = prevSnapshots.get(docName)

  // First call for this room: just record baseline, no diff
  if (!prev) {
    return recordChangesFromSnapshot(docName, room)
  }

  const changes = getStorageChangesSinceBaseline(docName, room)
  if (!changes) return null

  // If storage can no longer tell us every deletion since the previous clock,
  // fall back to the old whole-doc diff once to restore a correct baseline.
  if (changes.wipeAll) return recordChangesFromSnapshot(docName, room)

  const entries = []
  const ts = Date.now()
  const currentClock = changes.documentClock

  for (const [id, value] of Object.entries(changes.diff.puts ?? {})) {
    const state = Array.isArray(value) ? value[1] : value
    const old = prev.get(id)
    if (!old) {
      entries.push({ ts, action: 'create', id, type: state.typeName, shapeType: state.type, state })
    } else {
      const diff = shallowDiff(old.state, state)
      if (diff) {
        entries.push({ ts, action: 'update', id, type: state.typeName, shapeType: state.type, diff })
      }
    }
    prev.set(id, { state, clock: currentClock })
  }

  for (const id of changes.diff.deletes ?? []) {
    const old = prev.get(id)
    if (old) {
      const { state } = old
      entries.push({ ts, action: 'delete', id, type: state.typeName, shapeType: state.type })
      prev.delete(id)
    }
  }

  prevSnapshotClocks.set(docName, currentClock)

  return writeInterestingChanges(docName, entries)
}

function flushChangeLog(docName, room) {
  changeTimers.delete(docName)
  const changes = recordChanges(docName, room)
  notifyChangeListeners(docName, changes)
}

function scheduleChangeFlush(docName, room) {
  if (changeTimers.has(docName)) clearTimeout(changeTimers.get(docName))
  changeTimers.set(docName, setTimeout(() => flushChangeLog(docName, room), 50))
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
 * @returns {Promise<TLSocketRoom>}
 */
// ─── Room-load throttle ────────────────────────────────────────────────────
// A server restart triggers a reconnection storm: every client/tab/daemon
// reconnects at once, and each reconnect loads its room's snapshot — an async
// readFile, then a SYNCHRONOUS JSON.parse + `new TLSocketRoom(initialSnapshot)`
// (CPU-heavy Yjs apply). Loading all of them concurrently pegs the single-
// threaded event loop, so /health and new requests can't get a turn for ~30s.
// Cap how many load at once and yield the loop between them, so the server
// stays responsive while rooms load in the background. Already-loaded rooms
// return immediately above and never touch this throttle (no steady-state cost).
const ROOM_LOAD_CONCURRENCY = 3
let _roomLoadsInFlight = 0
const _roomLoadWaiters = []
function _acquireRoomLoadSlot() {
  if (_roomLoadsInFlight < ROOM_LOAD_CONCURRENCY) {
    _roomLoadsInFlight++
    return Promise.resolve()
  }
  return new Promise(resolve => _roomLoadWaiters.push(resolve))
}
function _releaseRoomLoadSlot() {
  const next = _roomLoadWaiters.shift()
  if (next) next()           // hand the slot to the next waiter (count unchanged)
  else _roomLoadsInFlight--
}

export async function getOrCreateRoom(docName) {
  if (rooms.has(docName)) return rooms.get(docName)

  await _acquireRoomLoadSlot()
  try {
    // Re-check: another caller may have created it while we waited for a slot.
    if (rooms.has(docName)) return rooms.get(docName)

    const snapshot = await loadSnapshot(docName)
    // Re-check after await — another concurrent caller may have already created it
    if (rooms.has(docName)) return rooms.get(docName)

    const opts = {
      schema,
      log: {
        warn: (...args) => console.warn(`[sync:${docName}]`, ...args),
        error: (...args) => console.error(`[sync:${docName}]`, ...args),
      },
      onSessionRemoved: (_room, { sessionId, numSessionsRemaining }) => {
        console.log(`[sync] Session removed from "${docName}": ${sessionId} (${numSessionsRemaining} remaining)`)
      },
      onDataChange: () => {
        scheduleSave(docName, room)
        scheduleChangeFlush(docName, room)
      },
      onAfterReceiveMessage: ({ message }) => {
        if (message?.type === 'push') scheduleSave(docName, room)
      },
    }

    let room
    if (snapshot) {
      opts.initialSnapshot = snapshot
      room = new TLSocketRoom(opts)
      setChangelogBaseline(docName, snapshot)
      console.log(`[sync] Room created: ${docName} (loaded snapshot)`)
    } else {
      room = new TLSocketRoom(opts)
      console.log(`[sync] Room created: ${docName}`)
    }

    rooms.set(docName, room)
    // Yield so /health and other requests can run before the next queued load.
    await new Promise(r => setImmediate(r))
    return room
  } finally {
    _releaseRoomLoadSlot()
  }
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
export async function getRoomRecords(docName, typeFilter) {
  const room = await getOrCreateRoom(docName)

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
  const room = await getOrCreateRoom(docName)
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
  const room = await getOrCreateRoom(docName)
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
export async function getRecord(docName, recordId) {
  const room = await getOrCreateRoom(docName)
  return room.getRecord(recordId) ?? null
}

// --- Signal cache + listeners ---

/** @type {Map<string, Map<string, object>>} docName → (signalKey → {key, ...data, timestamp}) */
const signalCache = new Map()

/** @type {Map<string, Set<(signal: object) => void>>} */
const signalListeners = new Map()

function describeSignalError(err) {
  return err?.stack || err?.message || String(err)
}

function reportSignalFailure(failure) {
  const enriched = {
    timestamp: Date.now(),
    ...failure,
    error: describeSignalError(failure.error),
  }
  if (!signalFailureReporter) {
    console.warn('[sync-signal] failure:', JSON.stringify(enriched))
    return
  }
  Promise.resolve(signalFailureReporter(enriched)).catch((err) => {
    console.error('[sync-signal] failure reporter failed:', describeSignalError(err))
  })
}

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
      try {
        cb(message)
      } catch (err) {
        reportSignalFailure({
          operation: 'listener',
          docName,
          key,
          error: err,
        })
      }
    }
  }

  const room = rooms.get(docName)
  if (!room) return
  for (const session of room.getSessions()) {
    if (session.isConnected) {
      try {
        room.sendCustomMessage(session.sessionId, message)
      } catch (err) {
        reportSignalFailure({
          operation: 'broadcast-send',
          docName,
          key,
          sessionId: session.sessionId,
          error: err,
        })
      }
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
  for (const [key, maxAge] of Object.entries(SIGNAL_REPLAY_WINDOWS)) {
    const cached = cache.get(key)
    if (cached && (now - (cached.timestamp || 0)) < maxAge) {
      try {
        room.sendCustomMessage(sessionId, cached)
      } catch (err) {
        reportSignalFailure({
          operation: 'replay-send',
          docName,
          key,
          sessionId,
          error: err,
        })
      }
    }
  }
}

// ─── Global events (cross-document) ─────────────────────────────

/** @type {Set<(event: object) => void>} */
const globalEventListeners = new Set()

/**
 * Emit a global event to all SSE subscribers (cross-document).
 * @param {string} type - Event type (e.g., 'doc-arrived')
 * @param {object} data - Event payload
 */
export function emitGlobalEvent(type, data) {
  const event = { type, ...data, timestamp: Date.now() }
  for (const cb of globalEventListeners) {
    try { cb(event) } catch {}
  }
}

/**
 * Subscribe to global events. Returns unsubscribe function.
 * @param {(event: object) => void} callback
 * @returns {() => void}
 */
export function onGlobalEvent(callback) {
  globalEventListeners.add(callback)
  return () => globalEventListeners.delete(callback)
}

/**
 * Delete a shape from a room.
 * @param {string} docName
 * @param {string} shapeId
 */
export async function deleteShape(docName, shapeId) {
  const room = await getOrCreateRoom(docName)
  room.storage.transaction((txn) => {
    txn.delete(shapeId)
  })
}

/**
 * Flush all pending saves (for graceful shutdown).
 */
export function flushAllRooms() {
  for (const [docName, timer] of changeTimers) {
    clearTimeout(timer)
    const room = rooms.get(docName)
    if (room) {
      try {
        flushChangeLog(docName, room)
      } catch (e) {
        console.error(`[sync] Failed to flush changelog for ${docName}:`, e.message)
      }
    } else {
      changeTimers.delete(docName)
    }
  }

  for (const [docName, timer] of saveTimers) {
    clearTimeout(timer)
    saveTimers.delete(docName)
    const room = rooms.get(docName)
    if (room) {
      try {
        // Use synchronous writes at shutdown so process.exit() doesn't interrupt them.
        const path = snapshotPath(docName)
        const dir = dirname(path)
        mkdirSync(dir, { recursive: true })
        const snapshot = room.getCurrentSnapshot()
        const tmp = path + '.tmp'
        writeFileSync(tmp, JSON.stringify(snapshot))
        renameSync(tmp, path)
        console.log(`[sync] Flushed snapshot: ${docName}`)
      } catch (e) {
        console.error(`[sync] Failed to flush ${docName}:`, e.message)
      }
    }
  }
}

/**
 * Replace a room's snapshot. Closes the existing room, writes the new snapshot
 * to disk, and lets it reload on next access. Connected clients will reconnect.
 */
export function replaceRoomSnapshot(docName, snapshot) {
  const existing = rooms.get(docName)
  if (existing) {
    existing.close()
    rooms.delete(docName)
    console.log(`[sync] Room closed for snapshot replace: ${docName}`)
  }
  const changeTimer = changeTimers.get(docName)
  if (changeTimer) {
    clearTimeout(changeTimer)
    changeTimers.delete(docName)
  }
  const path = snapshotPath(docName)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(snapshot))
  renameSync(tmp, path)
  setChangelogBaseline(docName, snapshot)
  console.log(`[sync] Snapshot replaced: ${docName}`)
}

// --- Shape history replay ---

/** @type {Map<string, { shapes: object[], ts: number }>} LRU cache for shape-at queries */
const shapeAtCache = new Map()
const SHAPE_AT_CACHE_MAX = 50

/**
 * Reconstruct the set of shapes that existed at a given timestamp.
 * Streams the shape changelog JSONL line-by-line to avoid blocking the event
 * loop on large files (survival-draft's log is 75 MB+).
 *
 * Pre-changelog shapes (in current snapshot but never mentioned in changelog)
 * are included — they existed before the changelog started.
 *
 * @param {string} projectName
 * @param {number} timestamp - Unix ms timestamp
 * @returns {Promise<{ shapes: object[], changelogRange: { first: number, last: number } | null }>}
 */
export async function getShapesAt(projectName, timestamp) {
  const cacheKey = `${projectName}:${timestamp}`
  if (shapeAtCache.has(cacheKey)) {
    // Move to end (most recently used)
    const cached = shapeAtCache.get(cacheKey)
    shapeAtCache.delete(cacheKey)
    shapeAtCache.set(cacheKey, cached)
    return cached
  }

  const docName = `doc-${projectName}`
  const logPath = changelogPath(docName)

  // Read changelog async (libuv thread pool — event loop stays free during read),
  // then parse in batches to avoid a 1-2s synchronous parse block.
  let entries = []
  try {
    const raw = await readFile(logPath)
    const content = gunzipSync(raw).toString('utf-8')
    const lines = content.split('\n')
    const BATCH = 500
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (entry) entries.push(entry)
      } catch {}
      // Yield to event loop every BATCH lines; 500 lines ≈ 15ms at typical parse rates
      if (i > 0 && i % BATCH === 0) await new Promise(r => setImmediate(r))
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[sync] Failed to read changelog for ${projectName}:`, e.message)
    }
  }

  entries.sort((a, b) => a.ts - b.ts)

  const changelogRange = entries.length > 0
    ? { first: entries[0].ts, last: entries[entries.length - 1].ts }
    : null

  // Replay: apply all ops up to timestamp
  const shapes = new Map() // id → state

  for (const entry of entries) {
    if (entry.ts > timestamp) break

    switch (entry.action) {
      case 'create':
        if (entry.state) shapes.set(entry.id, { ...entry.state })
        break
      case 'update': {
        const existing = shapes.get(entry.id)
        if (existing && entry.diff) {
          for (const [key, change] of Object.entries(entry.diff)) {
            if (typeof change === 'object' && change !== null && 'to' in change) {
              existing[key] = change.to
            }
          }
        }
        break
      }
      case 'delete':
        shapes.delete(entry.id)
        break
    }
  }

  // Include pre-changelog shapes: shapes in the current snapshot that
  // never appeared in the changelog at all (existed before logging started)
  const mentionedIds = new Set(entries.map(e => e.id))
  const snapPath = snapshotPath(docName)
  try {
    const snapData = await readFile(snapPath, 'utf-8')
    const snapshot = JSON.parse(snapData)
    for (const doc of (snapshot.documents || [])) {
      const state = doc.state
      if (!state?.id) continue
      if (state.typeName !== 'shape') continue
      if (mentionedIds.has(state.id)) continue
      shapes.set(state.id, state)
    }
  } catch {}

  // Filter to shape data only (type, props, meta, position)
  const result = {
    shapes: [...shapes.values()].map(s => {
      if (s.type === 'svg-page' || s.type === 'html-page') {
        return { id: s.id, type: s.type, typeName: s.typeName, x: s.x, y: s.y, props: s.props, meta: s.meta }
      }
      return s
    }),
    changelogRange,
  }

  // Cache with LRU eviction
  shapeAtCache.set(cacheKey, result)
  if (shapeAtCache.size > SHAPE_AT_CACHE_MAX) {
    const oldest = shapeAtCache.keys().next().value
    shapeAtCache.delete(oldest)
  }

  return result
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

export const __testSyncChangelog = {
  recordChanges,
  recordChangesFromSnapshot,
  setChangelogBaseline,
  reset() {
    for (const timer of changeTimers.values()) clearTimeout(timer)
    changeTimers.clear()
    prevSnapshots.clear()
    prevSnapshotClocks.clear()
  },
}
