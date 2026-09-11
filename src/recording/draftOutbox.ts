import type { RecordingMeta } from './recorder'

export interface DraftEnvelope {
  key: string
  doc: string
  id: string
  meta: RecordingMeta
  audio: Blob
  metadataAcknowledged: boolean
}

export interface DraftOutboxStore {
  put(envelope: DraftEnvelope): Promise<void>
  list(): Promise<DraftEnvelope[]>
  delete(key: string): Promise<void>
}

type DraftSender = (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number }>

/** How long any one IndexedDB transaction may take before it is given up on. */
const TRANSACTION_TIMEOUT_MS = 1500

function browserStore(): DraftOutboxStore {
  if (typeof indexedDB === 'undefined') return memoryStore
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tlda-recording-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void) => {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      // A transaction that never settles is the dangerous case, and it is not
      // hypothetical: quota pressure, a second tab holding the store, or a slow
      // disk can leave one open indefinitely — and because IndexedDB serializes
      // readwrite transactions over the same store, ONE stuck transaction
      // blocks every later one. Unbounded, that turned "the browser cannot
      // save a draft" into "the lecture is never delivered at all".
      const bail = setTimeout(() => {
        try { db.close() } catch { /* already gone */ }
        reject(new Error(`IndexedDB '${mode}' did not settle within ${TRANSACTION_TIMEOUT_MS}ms`))
      }, TRANSACTION_TIMEOUT_MS)
      const settle = (fn: () => void) => { clearTimeout(bail); fn() }
      const tx = db.transaction('drafts', mode)
      let result: T
      run(tx.objectStore('drafts'), value => { result = value })
      tx.onerror = () => settle(() => { try { db.close() } catch { /* already gone */ } ; reject(tx.error) })
      tx.oncomplete = () => settle(() => { db.close(); resolve(result) })
    })
  }
  return {
    put: envelope => transaction<void>('readwrite', (store, done) => { const r = store.put(envelope); r.onsuccess = () => done() }),
    list: () => transaction<DraftEnvelope[]>('readonly', (store, done) => { const r = store.getAll(); r.onsuccess = () => done(r.result) }),
    delete: key => transaction<void>('readwrite', (store, done) => { const r = store.delete(key); r.onsuccess = () => done() }),
  }
}

const memoryDrafts = new Map<string, DraftEnvelope>()
const memoryStore: DraftOutboxStore = {
  async put(envelope) { memoryDrafts.set(envelope.key, envelope) },
  async list() { return [...memoryDrafts.values()] },
  async delete(key) { memoryDrafts.delete(key) },
}

/**
 * The local store is a safety net for the recording, never a precondition for
 * delivering it. Its bookkeeping — marking the metadata acknowledged, clearing
 * a delivered draft — must not be able to abort an upload that is otherwise
 * fine, because a wedged IndexedDB would then lose the lecture it exists to
 * protect. A failure here costs at worst a redundant re-delivery later, and the
 * server stores by recording id, so that is idempotent.
 */
async function bookkeep(what: string, run: () => Promise<void>) {
  try {
    await run()
  } catch (error) {
    console.warn(`[recording] draft bookkeeping (${what}) failed; delivery continues`, error)
  }
}

async function deliver(envelope: DraftEnvelope, store: DraftOutboxStore, send: DraftSender) {
  const base = typeof window === 'undefined'
    ? 'http://localhost'
    : ((window as Window & { __tlda_server?: string }).__tlda_server || window.location.origin)
  if (!envelope.metadataAcknowledged) {
    const response = await send(`${base}/api/projects/${envelope.doc}/recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope.meta),
    })
    // A checkpoint that finished after final delivery can reappear in IndexedDB.
    // The server rejects it when a longer recording with this id already exists;
    // discard that stale envelope without posting its shorter audio over the
    // complete lecture.
    if (response.status === 409) {
      await bookkeep('discard-stale', () => store.delete(envelope.key))
      return
    }
    if (!response.ok) throw new Error(`meta POST ${response.status}`)
    envelope = { ...envelope, metadataAcknowledged: true }
    await bookkeep('acknowledge', () => store.put(envelope))
  }
  const response = await send(`${base}/api/projects/${envelope.doc}/recording/${envelope.id}/audio`, {
    method: 'POST', headers: { 'Content-Type': envelope.meta.audioMime.split(';')[0] }, body: envelope.audio,
  })
  if (!response.ok) throw new Error(`audio POST ${response.status}`)
  await bookkeep('clear', () => store.delete(envelope.key))
}

export async function persistAndDeliverDraft(
  doc: string,
  id: string,
  meta: RecordingMeta,
  audio: Blob,
  store: DraftOutboxStore = browserStore(),
  send: DraftSender = fetch,
) {
  const envelope = { key: `${doc}:${id}`, doc, id, meta, audio, metadataAcknowledged: false }
  // Persisted FIRST so a crash mid-upload still leaves the lecture recoverable,
  // but not required: the bytes being delivered are already in hand, and a
  // store that cannot accept them is no reason to drop them on the floor.
  await bookkeep('persist', () => store.put(envelope))
  await deliver(envelope, store, send)
}

/**
 * Drop a draft that is no longer wanted.
 *
 * Used after the lecture has been delivered, once any checkpoint that was still
 * in flight has settled: that write carries an older, shorter envelope, and
 * letting it sit in the outbox would have the retry path re-POST it over the
 * finished recording — the server stores by id, so the partial would win.
 */
export async function discardDraft(doc: string, id: string, store: DraftOutboxStore = browserStore()) {
  await store.delete(`${doc}:${id}`)
}

export async function persistDraftCheckpoint(
  doc: string,
  id: string,
  meta: RecordingMeta,
  audio: Blob,
  store: DraftOutboxStore = browserStore(),
) {
  await store.put({ key: `${doc}:${id}`, doc, id, meta, audio, metadataAcknowledged: false })
}

/**
 * Deliver every draft the outbox is still holding.
 *
 * One envelope's failure must not end the run. `deliver` throws on any non-ok
 * response, so an undeliverable draft — an oversized one the server refuses, say
 * — used to abort the loop and leave every envelope behind it unattempted, on
 * that load and on every load after it. A single bad recording could keep good
 * ones from ever reaching the server.
 *
 * Each draft is therefore tried on its own, and a failure is reported only after
 * the rest have had their turn.
 */
export async function retryPendingDrafts(store: DraftOutboxStore = browserStore(), send: DraftSender = fetch) {
  const failures: unknown[] = []
  for (const envelope of await store.list()) {
    try {
      await deliver(envelope, store, send)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} draft(s) undelivered: ${failures.map(String).join('; ')}`)
  }
}
