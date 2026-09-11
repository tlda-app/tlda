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
      const tx = db.transaction('drafts', mode)
      let result: T
      run(tx.objectStore('drafts'), value => { result = value })
      tx.onerror = () => reject(tx.error)
      tx.oncomplete = () => { db.close(); resolve(result) }
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

async function deliver(envelope: DraftEnvelope, store: DraftOutboxStore, send: DraftSender) {
  const base = typeof window === 'undefined'
    ? 'http://localhost'
    : ((window as Window & { __tlda_server?: string }).__tlda_server || window.location.origin)
  if (!envelope.metadataAcknowledged) {
    const response = await send(`${base}/api/projects/${envelope.doc}/recording`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope.meta),
    })
    if (!response.ok) throw new Error(`meta POST ${response.status}`)
    envelope = { ...envelope, metadataAcknowledged: true }
    await store.put(envelope)
  }
  const response = await send(`${base}/api/projects/${envelope.doc}/recording/${envelope.id}/audio`, {
    method: 'POST', headers: { 'Content-Type': envelope.meta.audioMime.split(';')[0] }, body: envelope.audio,
  })
  if (!response.ok) throw new Error(`audio POST ${response.status}`)
  await store.delete(envelope.key)
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
  await store.put(envelope)
  await deliver(envelope, store, send)
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
