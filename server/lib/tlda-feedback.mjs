// tlda-feedback.mjs — push-channel subscription for document annotations.
//
// Agents call `monitor_add(doc)` via MCP → WS → server stores the
// subscription. When a new feedback shape (math-note, draw, highlight, etc.)
// appears in the doc's Yjs room, or when a ping signal fires, the server
// posts a fleet chat message from `fleet:tlda` to every subscribed agent.
// The message appears in the agent's context as a normal `<channel
// source="fleet">` system-reminder — same delivery path as user chat.
//
// Replaces the tlda-listen-hook.sh PostToolUse polling approach.

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

/** @type {Map<string, Set<string>>} docName → Set<agent_id> */
const subscriptions = new Map()

/** @type {Map<string, { unsubShape: Function, unsubSignal: Function }>} */
const activeListeners = new Map()

/** Feedback shape types that get reported as "drawings" */
const DRAW_TYPES = new Set(['draw', 'highlight', 'arrow', 'geo', 'text', 'line'])

/**
 * Lazy-attach sync-room listeners for a doc the first time anyone subscribes.
 * Detaches when the last subscriber leaves.
 *
 * @param {string} docName
 * @param {(opts: { from: string, to: string, text: string, metadata: object }) => void} deliverChat
 *   Callback that performs the full delivery pipeline: fleetStore.share +
 *   fleetStore.addUnread + broadcastEvent. Supplied by the caller so we
 *   don't have to import unified-server internals here.
 */
function ensureListeners(docName, deliverChat) {
  if (activeListeners.has(docName)) return

  const displayName = docName.startsWith('doc-') ? docName.slice(4) : docName

  const send = (text, extraMetadata = {}) => {
    const subs = subscriptions.get(docName)
    if (!subs || subs.size === 0) return
    for (const agent of subs) {
      try {
        deliverChat({
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
 * Subscribe an agent to feedback notifications for a doc.
 * @param {string} agent_id
 * @param {string} docName
 * @param {(opts: { from: string, to: string, text: string, metadata: object }) => void} deliverChat
 *   Full delivery pipeline callback (share + addUnread + broadcast).
 * @returns {{ ok: true }}
 */
export function subscribe(agent_id, projectName, deliverChat) {
  if (!agent_id || !projectName) throw new Error('missing agent_id or projectName')
  if (typeof deliverChat !== 'function') throw new Error('deliverChat required')
  const docName = toRoomName(projectName)
  if (!subscriptions.has(docName)) subscriptions.set(docName, new Set())
  subscriptions.get(docName).add(agent_id)
  ensureListeners(docName, deliverChat)
  return { ok: true }
}

/**
 * Unsubscribe an agent from a doc.
 * @param {string} agent_id
 * @param {string} docName
 * @returns {{ ok: true }}
 */
export function unsubscribe(agent_id, projectName) {
  const docName = toRoomName(projectName)
  const subs = subscriptions.get(docName)
  if (!subs) return { ok: true }
  subs.delete(agent_id)
  if (subs.size === 0) {
    releaseListeners(docName)
    subscriptions.delete(docName)
  }
  return { ok: true }
}

/**
 * Unsubscribe an agent from all docs. Called when the agent's WS disconnects.
 * @param {string} agent_id
 */
export function unsubscribeAll(agent_id) {
  if (!agent_id) return
  for (const [docName, subs] of [...subscriptions.entries()]) {
    if (subs.has(agent_id)) unsubscribe(agent_id, docName)
  }
}

/**
 * Return the list of docs an agent is subscribed to.
 * @param {string} agent_id
 * @returns {string[]}
 */
export function list(agent_id) {
  const docs = []
  for (const [docName, subs] of subscriptions) {
    if (subs.has(agent_id)) docs.push(docName.startsWith('doc-') ? docName.slice(4) : docName)
  }
  return docs.sort()
}

/**
 * Get all agent IDs subscribed to a given project.
 * @param {string} projectName
 * @returns {string[]}
 */
export function subscribers(projectName) {
  const docName = toRoomName(projectName)
  const subs = subscriptions.get(docName)
  return subs ? [...subs] : []
}

/**
 * Snapshot for debugging / admin.
 * @returns {{ docName: string, agents: string[] }[]}
 */
export function snapshot() {
  return [...subscriptions.entries()].map(([docName, subs]) => ({
    docName,
    agents: [...subs].sort(),
  }))
}
