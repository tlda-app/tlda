import { persistAndDeliverDraft, persistDraftCheckpoint, retryPendingDrafts, type DraftEnvelope, type DraftOutboxStore } from './draftOutbox'

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`)
}

const rows = new Map<string, DraftEnvelope>()
const store: DraftOutboxStore = {
  async put(row) { rows.set(row.key, { ...row }) },
  async list() { return [...rows.values()] },
  async delete(key) { rows.delete(key) },
}
const meta = {
  id: 'lecture', title: 'Lecture', doc: 'course', created: new Date(0).toISOString(),
  duration_ms: 1000, audioMime: 'audio/webm', events: [], baseSnapshot: null,
}

await persistDraftCheckpoint('course', 'pre-exit', { ...meta, id: 'pre-exit' }, new Blob(['completed-timeslice']), store)
equal(rows.size, 1)
const recoveryRequests: string[] = []
await retryPendingDrafts(store, async (url) => { recoveryRequests.push(url); return { ok: true, status: 200 } })
equal(recoveryRequests.length, 2)
equal(rows.size, 0)

let calls = 0
try {
  await persistAndDeliverDraft('course', 'lecture', meta, new Blob(['audio']), store, async () => {
    calls += 1
    return { ok: calls === 1, status: calls === 1 ? 200 : 503 }
  })
  throw new Error('Expected audio failure')
} catch (error) {
  if (!String(error).includes('audio POST 503')) throw error
}
equal(rows.size, 1)
equal(rows.get('course:lecture')?.metadataAcknowledged, true)

const retryUrls: string[] = []
await retryPendingDrafts(store, async (url) => { retryUrls.push(url); return { ok: true, status: 200 } })
equal(retryUrls.length, 1)
equal(retryUrls[0].endsWith('/audio'), true)
equal(rows.size, 0)

// One undeliverable draft must not take the rest of the outbox down with it.
// A recording the server refuses outright — an oversized one, say — used to
// abort the whole loop, so every draft behind it went unattempted on that load
// and on every load afterwards.
await persistDraftCheckpoint('course', 'refused', { ...meta, id: 'refused' }, new Blob(['big']), store)
await persistDraftCheckpoint('course', 'ordinary', { ...meta, id: 'ordinary' }, new Blob(['small']), store)
equal(rows.size, 2)

const attempted: string[] = []
let raised = ''
try {
  await retryPendingDrafts(store, async (url) => {
    attempted.push(url)
    // The refused draft fails at its very first request, before the queue
    // would otherwise reach the draft sitting behind it.
    if (url.includes('refused')) return { ok: false, status: 413 }
    return { ok: true, status: 200 }
  })
} catch (error) {
  raised = String(error)
}

// The good draft was delivered and cleared...
equal(rows.has('course:ordinary'), false)
equal(attempted.some(url => url.includes('ordinary')), true)
// ...the refused one is kept for a later attempt rather than silently dropped...
equal(rows.has('course:refused'), true)
// ...and the failure is still reported rather than swallowed.
equal(raised.includes('undelivered'), true)

// Control: the refused draft really was refused, so the pass above is not the
// result of a sender that never failed.
equal(attempted.some(url => url.includes('refused')), true)
rows.delete('course:refused')

// A checkpoint that lands after the complete lecture was delivered must not
// follow a rejected metadata overwrite with a shorter audio overwrite.
await persistDraftCheckpoint('course', 'stale', { ...meta, id: 'stale', duration_ms: 500 }, new Blob(['short']), store)
const staleUrls: string[] = []
await retryPendingDrafts(store, async (url) => {
  staleUrls.push(url)
  return { ok: false, status: 409 }
})
equal(staleUrls.length, 1)
equal(staleUrls[0].endsWith('/recording'), true)
equal(rows.has('course:stale'), false)

console.log('durable draft outbox retry: PASS')
