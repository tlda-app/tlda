// tlda-feedback.mjs — push-channel subscription for document annotations.
//
// An agent calls `subscribe(query: "doc:<name>")` → the server writes a
// `document_monitor` row in the subscriptions table. When a new feedback shape
// (math-note, draw, highlight, etc.) appears in the doc's Yjs room, or when a
// ping signal fires, the server posts a fleet chat message from `fleet:tlda` to
// every subscribed agent. The message appears in the agent's context as a
// normal `<channel source="fleet">` system-reminder — same delivery path as
// user chat.
//
// The subscriptions TABLE is the only record of who is subscribed. This module
// keeps no second copy: it holds room listeners (a real resource that must be
// attached and detached) and reads the subscriber set from the store on every
// delivery. A module-level Set used to mirror the table, and the two drifted —
// a socket close dropped the in-memory entry while the row survived, so the
// agent kept believing it was subscribed while nothing was armed.

import { onShapeChange, onSignal } from './sync-rooms.mjs'

const TLDA_FEEDBACK_FROM = 'fleet:tlda'

/**
 * Map a user-facing project name (e.g. "bregman") to the sync-rooms docName
 * (e.g. "doc-bregman"). Callers pass the project name; internally we always
 * operate on the prefixed name to match sync-rooms / viewer conventions.
 */
function toRoomName(projectName) {
  return projectName.startsWith('doc-') ? projectName : `doc-${projectName}`
}

function toDisplayName(docName) {
  return docName.startsWith('doc-') ? docName.slice(4) : docName
}

/** @type {Map<string, { unsubShape: Function, unsubSignal: Function }>} */
const activeListeners = new Map()

/**
 * Injected once at server startup. `listDocSubscriptions()` returns the durable
 * `document_monitor` rows as `{ owner, doc }`; `deliverChat` runs the full
 * share + addUnread + broadcast pipeline.
 * @type {{ listDocSubscriptions: () => { owner: string, doc: string }[], deliverChat: Function } | null}
 */
let store = null

export function configure({ listDocSubscriptions, deliverChat }) {
  if (typeof listDocSubscriptions !== 'function') throw new Error('listDocSubscriptions required')
  if (typeof deliverChat !== 'function') throw new Error('deliverChat required')
  store = { listDocSubscriptions, deliverChat }
}

/** Feedback shape types that get reported as "drawings" */
const DRAW_TYPES = new Set(['draw', 'highlight', 'arrow', 'geo', 'text', 'line'])

/**
 * Attach sync-room listeners for a doc. Idempotent — the listeners stay up for
 * as long as the doc has at least one persisted subscriber, and are released
 * only by `unsubscribe`.
 *
 * @param {string} docName
 */
function ensureListeners(docName) {
  if (activeListeners.has(docName)) return
  if (!store) throw new Error('tlda-feedback used before configure()')

  const displayName = toDisplayName(docName)

  const send = (text, extraMetadata = {}) => {
    for (const agent of subscribers(displayName)) {
      try {
        store.deliverChat({
          from: TLDA_FEEDBACK_FROM,
          to: agent,
          text,
          metadata: { source: 'tlda-feedback', doc: displayName, ...extraMetadata },
        })
      } catch (e) {
        console.error(`[tlda-feedback] deliver failed: ${e.message}`)
      }
    }
  }

  const unsubShape = onShapeChange(docName, (event) => {
    if (!event.changes) return
    for (const change of event.changes) {
      // Only report new shapes. Updates and deletes are noisy — future work
      // could report selected-choice changes and edits.
      if (change.action !== 'create') continue
      const shape = change.state
      if (!shape || shape.typeName !== 'shape') continue
      const sType = shape.type

      if (sType === 'math-note') {
        const noteText = (shape.props?.text || '').trim()
        // Skip agent-authored notes (convention: start with "Claude:" or mention Todd)
        if (noteText.startsWith('Claude:') || /Todd/.test(noteText)) continue
        const preview = noteText.length > 120 ? noteText.slice(0, 120) + '…' : noteText
        const anchor = shape.meta?.sourceAnchor
        const anchorStr = anchor?.file
          ? ` (${anchor.file}${anchor.line ? ':' + anchor.line : ''})`
          : ''
        send(`[tlda feedback] New note on ${displayName} (${shape.id}): "${preview}"${anchorStr}`, { shape_id: shape.id, shape_type: sType })
      } else if (DRAW_TYPES.has(sType)) {
        const x = Math.round(shape.x || 0)
        const y = Math.round(shape.y || 0)
        send(`[tlda feedback] New ${sType} on ${displayName} (${shape.id}) at (${x}, ${y})`, { shape_id: shape.id, shape_type: sType })
      }
    }
  })

  const unsubSignal = onSignal(docName, (signal) => {
    if (signal.key === 'signal:ping') {
      send(`[tlda feedback] Ping on ${displayName}!`, { signal: 'ping' })
    } else if (signal.key === 'signal:build-progress') {
      const data = signal.value || {}
      if (data.phase === 'done') {
        send(
          `[writing checkpoint] Build complete for ${displayName}. Before moving on, check your recent edits:\n` +
          `1. WALKING — re-read as a first-time reader. Can you walk through it, or do you stop and climb?\n` +
          `2. CHUNKS — can you name what each paragraph/block does in one phrase?\n` +
          `3. LAYOUT — are related equations in the same display? Would a reader scroll back?\n` +
          `4. PENCIL — would the reader consider reaching for a pencil?\n` +
          `5. BORING — if Skip corrects this, will it be for an interesting reason or a boring one?`,
          { signal: 'writing-checkpoint', build_elapsed: data.detail }
        )
      }
    }
  })

  activeListeners.set(docName, { unsubShape, unsubSignal })
}

function releaseListeners(docName) {
  const listeners = activeListeners.get(docName)
  if (!listeners) return
  try { listeners.unsubShape() } catch {}
  try { listeners.unsubSignal() } catch {}
  activeListeners.delete(docName)
}

/**
 * Arm room listeners for a doc that has a persisted subscription. Call after
 * the durable row is written — the subscriber set is read from the store, so a
 * row that does not exist yet delivers to nobody.
 * @param {string} projectName
 * @returns {{ ok: true }}
 */
export function arm(projectName) {
  if (!projectName) throw new Error('missing projectName')
  ensureListeners(toRoomName(projectName))
  return { ok: true }
}

/**
 * Release a doc's room listeners once its last persisted subscription is gone.
 * Call after the durable row is deleted.
 * @param {string} projectName
 * @returns {{ ok: true }}
 */
export function releaseIfUnsubscribed(projectName) {
  if (!projectName) return { ok: true }
  if (subscribers(projectName).length === 0) releaseListeners(toRoomName(projectName))
  return { ok: true }
}

/**
 * Arm every doc that has a persisted subscription. Called once at startup so a
 * server restart brings the listeners back with the rows that outlived it.
 * @returns {number} number of docs armed
 */
export function armPersisted() {
  if (!store) throw new Error('tlda-feedback used before configure()')
  const docs = new Set(store.listDocSubscriptions().map(row => row.doc))
  for (const doc of docs) ensureListeners(toRoomName(doc))
  return docs.size
}

/**
 * Get all agent IDs subscribed to a given project, from the durable table.
 * @param {string} projectName
 * @returns {string[]}
 */
export function subscribers(projectName) {
  if (!store) return []
  const display = toDisplayName(toRoomName(projectName))
  return [...new Set(
    store.listDocSubscriptions()
      .filter(row => row.doc === display)
      .map(row => row.owner)
  )]
}
