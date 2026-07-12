/** Local resource authority for tlda-dev previews and Playwright. */
import { mkdirSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

export const DEFAULT_LEASE_FILE = join(homedir(), '.config', 'tlda', 'dev-resource-leases.json')

function readStore(file) {
  if (!existsSync(file)) return { version: 1, leases: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { version: 1, leases: Array.isArray(parsed.leases) ? parsed.leases : [] }
  } catch {
    // A corrupt authority file must not be silently treated as empty.
    throw new Error(`resource lease store is unreadable: ${file}`)
  }
}

function writeStore(file, store) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n')
  renameSync(tmp, file)
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Atomic rename protects readers from partial JSON; this lock protects writers
// from lost read-modify-write updates across concurrently running agents.
function withStoreLock(file, mutate, { timeoutMs = 30_000 } = {}) {
  const lock = `${file}.lock`
  const token = `${process.pid}:${Date.now()}:${Math.random()}`
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx' })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // A crashed writer must not wedge the authority forever. The token carries
      // its local pid, so reclaim only a demonstrably dead holder.
      try {
        const holder = Number(readFileSync(lock, 'utf8').split(':', 1)[0])
        if (Number.isInteger(holder) && holder > 0) {
          try { process.kill(holder, 0) } catch (livenessError) {
            if (livenessError?.code === 'ESRCH') unlinkSync(lock)
          }
        }
      } catch (readError) {
        if (readError?.code !== 'ENOENT') throw readError
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for resource lease lock: ${lock}`)
      waitMs(10)
    }
  }
  try {
    return mutate()
  } finally {
    // Only the lock holder may remove it; a failed ownership check leaves a loud
    // lock behind rather than deleting another process's authority boundary.
    if (readFileSync(lock, 'utf8') !== token) throw new Error(`resource lease lock ownership lost: ${lock}`)
    unlinkSync(lock)
  }
}

function policyWithExpiry(policy, now) {
  const ttlMs = Number(policy?.ttl_ms)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('lease policy.ttl_ms must be a positive number')
  return { ...policy, ttl_ms: ttlMs, expires_at: new Date(now + ttlMs).toISOString() }
}

export function acquireLease(input, { file = DEFAULT_LEASE_FILE, now = Date.now() } = {}) {
  if (!input?.kind || !input?.resource_id) throw new Error('lease kind and resource_id are required')
  return withStoreLock(file, () => {
    const store = readStore(file)
    const stamp = new Date(now).toISOString()
    const policy = policyWithExpiry(input.policy, now)
    const existing = store.leases.findIndex(l => l.resource_id === input.resource_id)
    const lease = {
      ...(existing >= 0 ? store.leases[existing] : {}),
      ...input,
      policy,
      created_at: existing >= 0 ? store.leases[existing].created_at : stamp,
      last_renewed: stamp,
      expires_at: policy.expires_at,
    }
    if (existing >= 0) store.leases[existing] = lease
    else store.leases.push(lease)
    writeStore(file, store)
    return lease
  })
}

export function renewLease(resourceId, updates = {}, options = {}) {
  const { file = DEFAULT_LEASE_FILE, now = Date.now() } = options
  return withStoreLock(file, () => {
    const store = readStore(file)
    const index = store.leases.findIndex(l => l.resource_id === resourceId)
    if (index < 0) throw new Error(`unknown resource lease: ${resourceId}`)
    const current = store.leases[index]
    const policy = policyWithExpiry({ ...current.policy, ...updates.policy }, now)
    const next = { ...current, ...updates, policy, last_renewed: new Date(now).toISOString(), expires_at: policy.expires_at }
    store.leases[index] = next
    writeStore(file, store)
    return next
  })
}

export function releaseLease(resourceId, { file = DEFAULT_LEASE_FILE } = {}) {
  return withStoreLock(file, () => {
    const store = readStore(file)
    const before = store.leases.length
    store.leases = store.leases.filter(l => l.resource_id !== resourceId)
    if (store.leases.length !== before) writeStore(file, store)
    return before !== store.leases.length
  })
}

export function releaseLeases(predicate, { file = DEFAULT_LEASE_FILE } = {}) {
  return withStoreLock(file, () => {
    const store = readStore(file)
    const released = store.leases.filter(predicate)
    if (released.length) {
      store.leases = store.leases.filter(l => !predicate(l))
      writeStore(file, store)
    }
    return released
  })
}

export function listLeases({ file = DEFAULT_LEASE_FILE, now = Date.now() } = {}) {
  return readStore(file).leases.map(lease => ({ ...lease, expired: Date.parse(lease.expires_at) <= now }))
}

// Return in cleanup order: tabs are parked before their pooled session; servers last.
export function expiredLeases({ file = DEFAULT_LEASE_FILE, now = Date.now() } = {}) {
  const order = { 'playwright-tab': 0, 'playwright-session': 1, 'preview-server': 2 }
  return listLeases({ file, now }).filter(l => l.expired).sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
}

export function formatLeaseMarkdownTable(leases = []) {
  const lines = [
    '### Resource Leases', '',
    '| Kind | Resource | Owner | Location | Runtime | Expires | State |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  if (!leases.length) lines.push('| — | No leased resources | — | — | — | — | — |')
  for (const lease of leases) {
    const meta = lease.metadata || {}
    const runtime = [meta.pid && `pid ${meta.pid}`, meta.ports?.length && `:${meta.ports.join(',')}`, meta.session, Number.isInteger(meta.tab) && `tab ${meta.tab}`].filter(Boolean).join('; ') || '—'
    const location = meta.worktree || meta.cwd || '—'
    lines.push(`| ${lease.kind} | ${lease.resource_id} | ${lease.owner?.id || '—'} | ${location} | ${runtime} | ${lease.expires_at || '—'} | ${lease.expired ? 'expired' : 'active'} |`)
  }
  return lines.join('\n')
}
