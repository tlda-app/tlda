// Read-only. Pulls every open task and its delegate events off the testing
// store, and works out which rows had their title overwritten by a hand-off.
//
// The rule, and it is exact rather than inferred: transferTaskLifecycle emits
// its delegate event with `task.description` -- the value BEFORE the transfer
// writes the new one. So a delegate event's text is the title as of just before
// that hand-off, and the first delegate event carries the title the task was
// created with.
import { ResilientWS, startWsRequest } from '../shared/fleet-transport.mjs'
import crypto from 'node:crypto'

const SERVER = process.env.TLDA_SERVER || 'https://tlda-fly.cormorant-matrix.ts.net'
const AGENT = process.env.FLEET_ID || 'fleet:8d2f3d14'
const WS_URL = `${SERVER.replace(/^http/, 'ws')}/ws/fleet?agent=${encodeURIComponent(AGENT)}`

function connect() {
  return new Promise(resolve => {
    const pending = new Map()
    const rws = new ResilientWS({
      url: () => WS_URL,
      label: 'read-task-events',
      connectAttemptTimeoutMs: 15000,
      log: s => process.stderr.write(`${s}\n`),
      onOpen: () => resolve({
        request(type, params = {}) {
          const id = crypto.randomUUID()
          return startWsRequest({
            pending,
            id,
            type,
            deadlineMs: 30000,
            send: requestId => rws.send({ type, ...params, id: requestId }),
          })
        },
        close: () => rws.close(),
      }),
      onMessage: msg => {
        const waiter = msg.id && pending.get(msg.id)
        if (!waiter) return
        if (msg.error) waiter.reject(new Error(msg.error))
        else waiter.resolve(msg.result ?? msg)
      },
    })
    rws.connect()
  })
}

// Mirrors deriveTaskDescription in mcp-server/fleet-tools.mjs BEFORE the fix --
// this is the function whose output got written over the titles, so it is what
// identifies a stamp.
function derivedPreFix(message) {
  const text = typeof message === 'string' ? message : ''
  const firstSentence = text.match(/^[^.!?\n]{5,60}[.!?]/)
  return firstSentence ? firstSentence[0] : text.slice(0, 60).trimEnd()
}

const conn = await connect()

const tasks = []
let cursor = null
do {
  const page = await conn.request('tasks-page', { limit: 200, cursor })
  tasks.push(...(page.tasks || []))
  cursor = page.nextCursor || null
} while (cursor)

process.stderr.write(`read ${tasks.length} open tasks\n`)

const rows = []
for (const task of tasks) {
  let events = []
  try {
    const r = await conn.request('task-events', { task_id: task.id })
    events = r.events || []
  } catch (e) {
    rows.push({ id: task.id, error: e.message })
    continue
  }
  const delegates = events
    .filter(e => e.type === 'delegate')
    .map(e => ({
      eventId: e.id,
      at: e.timestamp,
      text: e.text || '',
      message: (typeof e.metadata === 'string' ? JSON.parse(e.metadata || '{}') : (e.metadata || {})).message || '',
      transfer: !!(typeof e.metadata === 'string' ? JSON.parse(e.metadata || '{}') : (e.metadata || {})).transfer,
    }))
  rows.push({
    id: task.id,
    agent: task.agent,
    description: task.description || '',
    delegatedAt: task.delegated_at,
    delegates,
    // A stamp: the current title is exactly what the LAST hand-off's message
    // would have derived to.
    stampedBy: delegates.filter(d => d.message && derivedPreFix(d.message) === (task.description || '')),
  })
}

conn.close()
process.stdout.write(JSON.stringify(rows, null, 2))
