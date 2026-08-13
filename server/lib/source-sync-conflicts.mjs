import { readProject, updateProject } from './project-store.mjs'

export function sourceConflictOwner(fields = {}) {
  const daemonKey = fields.sourceDaemonKey || fields.daemonKey || null
  const machineId = fields.sourceMachineId || fields.machineId || null
  const envName = fields.sourceEnvName || fields.envName || null
  const participant = fields.editedBy || fields.participant || daemonKey || machineId || null
  return {
    id: daemonKey || participant || machineId || 'unknown',
    ...(participant ? { participant } : {}),
    ...(daemonKey ? { daemonKey } : {}),
    ...(machineId ? { machineId } : {}),
    ...(envName ? { envName } : {}),
  }
}

function ownerKey(owner = {}) {
  return owner.daemonKey || owner.id || owner.participant || owner.machineId || 'unknown'
}

function normalizeConflict(entry = {}) {
  const file = typeof entry.file === 'string' ? entry.file : typeof entry.path === 'string' ? entry.path : ''
  const refused = entry.status === 'refused'
  // A conflict is about a file, so one without a file is nothing. A refusal is
  // about a person: it can name no file at all and still be somebody stuck
  // outside the paper, which is the thing this exists to report.
  if (!file && !refused) return null
  const owner = sourceConflictOwner(entry.owner || entry)
  return {
    kind: refused ? 'source-refusal' : 'source-conflict',
    status: refused ? 'refused' : 'conflict',
    file,
    ...(refused && Array.isArray(entry.files) ? { files: entry.files } : {}),
    ...(refused && entry.reason ? { reason: entry.reason } : {}),
    ...(entry.stuckKey ? { stuckKey: entry.stuckKey } : {}),
    owner,
    ownerKey: ownerKey(owner),
    source: entry.source || 'source-authority',
    at: entry.at || new Date().toISOString(),
  }
}

export async function recordSourceSyncConflicts(projectName, conflicts = []) {
  const project = await readProject(projectName)
  if (!project) return []
  const existing = Array.isArray(project.sourceSyncConflicts) ? project.sourceSyncConflicts : []
  const byKey = new Map(existing
    .map(normalizeConflict)
    .filter(Boolean)
    .map(entry => [`${entry.file}\0${entry.ownerKey}`, entry]))
  for (const conflict of conflicts) {
    const entry = normalizeConflict(conflict)
    if (!entry) continue
    byKey.set(`${entry.file}\0${entry.ownerKey}`, entry)
  }
  const next = [...byKey.values()].sort((a, b) => a.file.localeCompare(b.file) || a.ownerKey.localeCompare(b.ownerKey))
  await updateProject(projectName, { sourceSyncConflicts: next })
  return next
}

export async function clearSourceSyncConflicts(projectName, files = [], owner = null) {
  const project = await readProject(projectName)
  if (!project) return []
  const existing = Array.isArray(project.sourceSyncConflicts) ? project.sourceSyncConflicts : []
  if (existing.length === 0) return []
  const fileSet = new Set((files || []).filter(file => typeof file === 'string' && file.length > 0))
  if (fileSet.size === 0) return existing
  const key = owner ? ownerKey(sourceConflictOwner(owner)) : null
  const next = existing.filter(entry => {
    const normalized = normalizeConflict(entry)
    if (!normalized || !fileSet.has(normalized.file)) return true
    return key ? normalized.ownerKey !== key : false
  })
  if (next.length !== existing.length) await updateProject(projectName, { sourceSyncConflicts: next })
  return next
}

/**
 * A refusal that produced no conflict markers.
 *
 * Measured on a real paper, 2026-08-13: a participant holding a stale revision
 * edited a bibliography nobody else had touched, was refused, and nothing was
 * recorded anywhere. Conflict state is written from classifications that came
 * back as `conflict` — files carrying marker text — so a refusal that produced
 * none leaves the project looking untroubled while somebody's work sits on one
 * machine.
 *
 * Kept in its own field rather than folded into sourceSyncConflicts, because
 * that is what the pill reads and what a person is shown is a product decision
 * rather than a sync one. The ledger reads both; the surface is unchanged until
 * somebody decides it should be.
 */
export async function recordSourceSyncRefusal(projectName, { owner, reason, files = [], file = null } = {}) {
  const project = await readProject(projectName)
  if (!project) return []
  const normalizedOwner = sourceConflictOwner(owner || {})
  const named = files.filter(entry => typeof entry === 'string' && entry)
  const entry = {
    kind: 'source-refusal',
    status: 'refused',
    file: file || named[0] || '',
    files: named,
    owner: normalizedOwner,
    ownerKey: ownerKey(normalizedOwner),
    // What counts as one stuck thing, and the two cases differ.
    //
    // A refused push is one row per person: a laptop refused ten times in a
    // minute is one person stuck, not ten problems, and the payload varies
    // between retries so keying on its files would breed a row per attempt.
    //
    // An editor room holding an unflushed edit is one row per file, because the
    // room is per file and one server is the owner of all of them. Keyed on the
    // person there, three stuck files would report as one.
    stuckKey: file ? `${ownerKey(normalizedOwner)}\0${file}` : ownerKey(normalizedOwner),
    source: 'source-authority',
    reason: reason || 'stale-base',
    at: new Date().toISOString(),
  }
  const existing = Array.isArray(project.sourceSyncRefusals) ? project.sourceSyncRefusals : []
  const keyOf = row => row?.stuckKey || row?.ownerKey
  const previous = existing.find(row => keyOf(row) === entry.stuckKey)
  // Keep the first timestamp. The age that matters is how long this has been
  // stuck, not when it was last retried — otherwise retrying keeps it looking
  // fresh forever, which is the failure mode of every alarm that resets itself.
  if (previous?.at) entry.at = previous.at
  const next = [...existing.filter(row => keyOf(row) !== entry.stuckKey), entry]
    .sort((a, b) => String(keyOf(a)).localeCompare(String(keyOf(b))))
  await updateProject(projectName, { sourceSyncRefusals: next })
  return next
}

/**
 * Their work reached the paper, so they are no longer stuck.
 *
 * With a file, this clears that one stuck file. Without, it clears everything
 * recorded against the owner — which is what an accepted push means for a
 * person: whatever they were carrying got in.
 */
export async function clearSourceSyncRefusal(projectName, owner, file = null) {
  const project = await readProject(projectName)
  if (!project) return []
  const existing = Array.isArray(project.sourceSyncRefusals) ? project.sourceSyncRefusals : []
  if (existing.length === 0) return []
  const key = ownerKey(sourceConflictOwner(owner || {}))
  const stuckKey = file ? `${key}\0${file}` : null
  const next = existing.filter(row => (stuckKey
    ? (row?.stuckKey || row?.ownerKey) !== stuckKey
    : row?.ownerKey !== key))
  if (next.length !== existing.length) await updateProject(projectName, { sourceSyncRefusals: next })
  return next
}

/**
 * The ledger: work that has not reached the paper, and how long it has been
 * waiting.
 *
 * Skip's criterion for this domain, 2026-08-13: "the goal is to not lose
 * fucking data." Git is the floor — anything that reached the remote or the
 * shadow history is recoverable — so the only losable edit is one that never
 * reached it, sitting on somebody's machine. This reports those.
 *
 * The alarm is AGE, not error. A conflict a minute old is two people working;
 * the same conflict at breakfast is somebody's paragraph that has been in
 * exactly one place all night. Callers ask `oldestWaitingMs` rather than
 * counting entries, because one stuck edit matters more than five fresh ones.
 *
 * Read-only, and it invents nothing: every entry here was already recorded
 * when a push was refused. What is new is asking how long it has sat.
 */
export function sourceSyncLedger(project, now = Date.now()) {
  const recorded = [
    ...(Array.isArray(project?.sourceSyncConflicts) ? project.sourceSyncConflicts : []),
    ...(Array.isArray(project?.sourceSyncRefusals) ? project.sourceSyncRefusals : []),
  ]
  const entries = recorded
    .map(entry => normalizeConflict(entry))
    .filter(Boolean)
    .map(entry => {
      const at = Date.parse(entry.at)
      // An unparseable timestamp is not zero-age. Treating it as fresh is how a
      // stuck edit hides, so it reports null and is never counted as recent.
      const waitingMs = Number.isFinite(at) ? Math.max(0, now - at) : null
      return { ...entry, waitingMs }
    })
    .sort((a, b) => (b.waitingMs ?? Infinity) - (a.waitingMs ?? Infinity))
  const waits = entries.map(entry => entry.waitingMs).filter(value => value != null)
  return {
    entries,
    oldestWaitingMs: entries.some(entry => entry.waitingMs == null) ? null
      : waits.length ? Math.max(...waits) : 0,
    unknownAge: entries.filter(entry => entry.waitingMs == null).length,
  }
}

/**
 * Has anything been waiting too long?
 *
 * `null` for oldestWaitingMs means at least one entry has no readable
 * timestamp, and that counts as stale rather than as fine — an instrument that
 * cannot see the failing case must not report health.
 */
export function sourceSyncIsStale(ledger, thresholdMs) {
  if (!ledger || ledger.entries.length === 0) return false
  if (ledger.oldestWaitingMs == null) return true
  return ledger.oldestWaitingMs >= thresholdMs
}

/**
 * Everything across every paper that has been waiting too long.
 *
 * A ledger nobody reads is not an instrument, and the alarm here is age, so
 * something has to look at the clock — no write happens at the moment an edit
 * becomes old. This is the sweep, kept pure so its caller decides how often and
 * what to do with it.
 *
 * Ordered oldest first across all papers, because the question a person asks is
 * "what is worst", not "what is where".
 */
export function staleSourceSyncEntries(projects = [], thresholdMs, now = Date.now()) {
  const stuck = []
  for (const project of projects) {
    const ledger = sourceSyncLedger(project, now)
    if (!sourceSyncIsStale(ledger, thresholdMs)) continue
    for (const entry of ledger.entries) {
      // An entry younger than the threshold in an otherwise stale paper is not
      // itself news. The exception is one with no readable age: it is reported
      // precisely because nobody can say it is fine.
      if (entry.waitingMs != null && entry.waitingMs < thresholdMs) continue
      stuck.push({ ...entry, project: project?.name || null })
    }
  }
  return stuck.sort((a, b) => (b.waitingMs ?? Infinity) - (a.waitingMs ?? Infinity))
}

/** One line a person can read, rather than a shape they have to decode. */
export function describeStuckEntry(entry) {
  const who = entry?.owner?.participant || entry?.owner?.machineId || entry?.owner?.daemonKey || 'somebody'
  const what = entry?.file ? `${entry.file}` : 'an edit'
  const where = entry?.project ? ` in ${entry.project}` : ''
  const age = entry?.waitingMs == null
    ? 'for an unknown length of time, because its timestamp cannot be read'
    : `for ${Math.round(entry.waitingMs / 60_000)} minutes`
  return `${who} has been holding ${what}${where} ${age}`
}
