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
console.log('durable draft outbox retry: PASS')
