import chokidar from 'chokidar'
import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'

import { scanMarkdownDependencyClosure } from '../shared/markdown-deps.mjs'
import { isBuildJunkPath, isIgnoredSourceDir, isSourceFilePath, isTextSourcePath, normalizeSourceManifest } from '../shared/source-manifest.mjs'
import { createSourceMaterializer } from './source-materializer.mjs'

export function resolveWatchedSourceFile(sourceWatchers, filePath) {
  if (!filePath || !path.isAbsolute(filePath)) return null
  const matches = []
  for (const [project, state] of sourceWatchers) {
    const rel = path.relative(path.resolve(state.sourceDir), path.resolve(filePath))
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      matches.push({ project, file: rel.replaceAll(path.sep, '/') })
    }
  }
  return matches.length === 1 ? matches[0] : null
}

export function createSourceChangeCorrelation({ makeId = randomUUID, log = console, now = Date.now } = {}) {
  const pending = new Map()
  const pendingProjects = new Set()
  // When each pending project's request went out, so a reply that never arrives
  // can be noticed. Without this a project sits in `pendingProjects` forever and
  // every later edit merges into `queued` and is never sent: on 2026-08-18 one
  // unanswered reply held `bregman` for 93 minutes, and because the durable
  // outbox re-registers an in-flight source-change through `beforeSend`, a daemon
  // restart re-armed the same wedge within three minutes.
  const pendingSince = new Map()
  const queued = new Map()
  const blocked = new Set()
  // The payload that drove a project into `blocked`, retained so the sync layer can
  // re-arm its file PATHS and re-submit instead of silently dropping the edit. The
  // bytes in it are deliberately not replayed — see deferBlockedProject.
  const blockedPayloads = new Map()
  const retries = []
  function clearBlock(project) {
    blocked.delete(project)
    blockedPayloads.delete(project)
  }

  function mergePayloads(previous, next) {
    if (!previous) return next
    if (!next) return previous
    const merged = { ...previous }
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) merged[key] = value
    }
    const files = new Map((previous.files || []).map(file => [file.path, file]))
    const deleted = new Set(previous.deletedFiles || [])
    for (const file of next.files || []) {
      files.set(file.path, file)
      deleted.delete(file.path)
    }
    for (const file of next.deletedFiles || []) {
      files.delete(file)
      deleted.add(file)
    }
    merged.files = [...files.values()]
    merged.deletedFiles = [...deleted]
    const operationRecords = payload => payload.editOperations || (payload.editOperation ? [{ agentId: payload.editedBy, operation: payload.editOperation }] : [])
    const operations = [...operationRecords(previous), ...operationRecords(next)]
    if (operations.length) merged.editOperations = [...new Map(operations.map(record => [record.operation?.operation_id, record])).values()]
    delete merged.editOperation
    return merged
  }

  return {
    prepare(payload, retried = false) {
      if (blocked.has(payload.project)) return null
      if (pendingProjects.has(payload.project)) {
        queued.set(payload.project, mergePayloads(queued.get(payload.project), payload))
        return null
      }
      const requestId = makeId()
      const message = { ...payload, requestId, expectedRevision: payload.expectedRevision ?? null, [DAEMON_OUTBOX_ID_FIELD]: payload[DAEMON_OUTBOX_ID_FIELD] || randomUUID() }
      pending.set(requestId, { project: payload.project, payload, retried })
      pendingProjects.add(payload.project)
      if (!pendingSince.has(payload.project)) pendingSince.set(payload.project, now())
      return message
    },
    beginReconnect() {
      // In-flight requests already live in the durable outbox and replay with
      // their original identity. Only later, unsent changes remain queued.
      pending.clear()
      pendingProjects.clear()
      pendingSince.clear()
    },
    finishReconnect() {
      const payloads = [...queued.values()]
      queued.clear()
      return payloads
    },
    handle(message) {
      const request = pending.get(message.requestId)
      if (!request || request.project !== message.project) return false
      pending.delete(message.requestId)
      const project = request.project
      pendingProjects.delete(project)
      pendingSince.delete(project)
      if (message.ok) {
        clearBlock(project)
      } else {
        const currentRevision = message.authority?.currentRevision
        if (message.status === 'stale-base' && typeof currentRevision === 'string') {
          if (!request.retried) {
            clearBlock(project)
            retries.push({ payload: { ...request.payload, expectedRevision: currentRevision }, retried: true })
          } else {
            blocked.add(project)
            blockedPayloads.set(project, request.payload)
          }
        } else if (message.status === 'stale-base') {
          blocked.add(project)
          blockedPayloads.set(project, request.payload)
        }
        log.warn(`source change rejected for ${project}: ${message.error || message.status || 'unknown'}`)
      }
      const queuedPayload = queued.get(project)
      if (queuedPayload && !blocked.has(project)) {
        queued.delete(project)
        retries.push({ payload: queuedPayload, retried: false })
      }
      return true
    },
    takeRetry() { return retries.shift() ?? null },
    // Release any project whose in-flight request has gone unanswered past
    // `deadlineMs`, and hand back a descriptor per project so the caller can say
    // so out loud. This is a DEADLINE, not a retry policy: it does not resend the
    // request that died, it does not back off, and it does not decide when to try
    // again. It only stops one lost reply from pinning a project for the rest of
    // the process's life. What it does release is the payload that was queued
    // BEHIND the dead request — those edits were never sent at all, and it hands
    // hands them back to the caller to send. Draining through `retries` would not
    // work here: that queue is only drained inside handleSourceChangeResult, and
    // the whole point of this path is that no result is coming.
    expireStalePending(deadlineMs) {
      const cutoff = now() - deadlineMs
      const expired = []
      for (const [project, since] of pendingSince) {
        if (since > cutoff) continue
        const requestIds = []
        for (const [requestId, request] of pending) {
          if (request.project === project) requestIds.push(requestId)
        }
        for (const requestId of requestIds) pending.delete(requestId)
        pendingProjects.delete(project)
        pendingSince.delete(project)
        let queuedPayload = queued.get(project) ?? null
        if (queuedPayload && blocked.has(project)) queuedPayload = null
        else if (queuedPayload) queued.delete(project)
        expired.push({ project, requestIds, waitedMs: now() - since, queuedPayload })
      }
      return expired
    },
    pendingRequest(requestId) { return pending.get(requestId) || null },
    settleOperations(project, operationIds) {
      if (!operationIds?.length) return
      const settled = new Set(operationIds)
      const filter = payload => {
        const records = payload.editOperations || (payload.editOperation ? [{ agentId: payload.editedBy, operation: payload.editOperation }] : [])
        const remaining = records.filter(record => !settled.has(record.operation?.operation_id))
        const next = { ...payload }
        delete next.editOperation
        delete next.editedBy
        if (remaining.length) next.editOperations = remaining
        else delete next.editOperations
        return next
      }
      if (queued.has(project)) queued.set(project, filter(queued.get(project)))
      for (const retry of retries) if (retry.payload?.project === project) retry.payload = filter(retry.payload)
    },
    restore(message) {
      if (!message?.requestId || !message?.project || pending.has(message.requestId)) return
      pending.set(message.requestId, { project: message.project, payload: message, retried: Boolean(message.retryOf) })
      pendingProjects.add(message.project)
    },
    // The person now has conflict markers in their own copy, so the machine
    // stops deciding: drop the automatic retry (it would re-send the pre-merge
    // text and silently clobber the other peer) and do not block either, so the
    // save that resolves the markers pushes normally against the revision we
    // just learned.
    holdForHuman(project) {
      clearBlock(project)
      for (let i = retries.length - 1; i >= 0; i--) {
        if (retries[i].payload?.project === project) retries.splice(i, 1)
      }
    },
    // Release a project's block without discarding anything else — used by the timed
    // self-heal so the resubmit races the server's refreshed base rather than waiting
    // for a differing daemon-welcome or a process restart.
    unblock(project) { clearBlock(project) },
    // The payload that drove `project` into `blocked`, consumed once. The sync layer
    // re-arms its file set from this so the next flush re-reads current disk bytes.
    takeBlockedPayload(project) {
      const payload = blockedPayloads.get(project) ?? null
      blockedPayloads.delete(project)
      return payload
    },
    state(project) {
      return {
        blocked: blocked.has(project),
        pending: pendingProjects.has(project),
        queued: queued.has(project),
      }
    },
  }
}

// Self-heal cadence for a source-sync `blocked` project. Once contention drove a
// project into `blocked`, every later edit was dropped with only a log.warn until a
// process restart. Instead we re-submit on a bounded exponential backoff: fast
// enough that transient two-machine contention clears in a couple of seconds,
// capped so a persistently-contended base cannot thrash the server. Every edit is
// eventually submitted or kept visibly failed — never lost.
const BLOCKED_RETRY_BASE_MS = 2000
const BLOCKED_RETRY_MAX_MS = 30000

export function createSourceSync({ sourceBindingsFile, log, sendMsg, isConnected, resolveEditor, sourceChangeSettleDeadlineMs, editOperationStore = null, verifyOutbox = () => null, retryFault = null, reconcileIntervalMs = 1000, now = Date.now, watch = chokidar.watch }) {
  if (typeof sourceChangeSettleDeadlineMs !== 'number' || !Number.isFinite(sourceChangeSettleDeadlineMs) || sourceChangeSettleDeadlineMs <= 0) {
    throw new Error(`createSourceSync requires a positive sourceChangeSettleDeadlineMs (got ${JSON.stringify(sourceChangeSettleDeadlineMs)})`)
  }
  const sourceWatchers = new Map()
  const sourceCorrelation = createSourceChangeCorrelation({ log, now })
  const sourceMaterializer = createSourceMaterializer({ journalPath: `${sourceBindingsFile}.materializations.json` })

  function sendSourceChange(payload, retried = false) {
    const binding = payload.sourceBindingId ? sourceMaterializer.readBinding(payload.sourceBindingId) : null
    const message = sourceCorrelation.prepare({
      ...payload,
      expectedRevision: binding?.serverHeadRevision ?? payload.expectedRevision ?? null,
    }, retried)
    if (!message) {
      const state = sourceCorrelation.state(payload.project)
      if (state.queued) log.info(`source change queued behind in-flight request for ${payload.project}`)
      else {
        // Blocked by stale-base contention. Do NOT drop the edit: re-arm its file
        // paths so the scheduled retry re-reads their current disk bytes, and
        // surface the block where a person can see it. The timed self-heal
        // resubmits; nothing waits for a restart.
        log.warn(`source authority blocked for ${payload.project}; queued for automatic retry`)
        deferBlockedProject(payload.project, payload)
      }
      return false
    }
    return sendMsg(message)
  }

  // A rejected push already carries the server's three-way merge for every file
  // it could compute one for. Write the conflicted text to this machine's own
  // copy so it becomes an ordinary git conflict the person resolves with their
  // own tools — the alternative is what happened before: the daemon goes quiet
  // and the only trace is a line in this log.
  function writeConflictsToWorkingCopy(message) {
    const classifications = message?.evidence?.classifications
    if (!Array.isArray(classifications)) return []
    const state = sourceWatchers.get(message.project)
    if (!state?.sourceDir) return []
    const written = []
    const failed = []
    for (const entry of classifications) {
      if (entry?.status !== 'conflict' || !entry.merged || !entry.path) continue
      const full = path.join(state.sourceDir, entry.path)
      if (!fs.existsSync(full)) continue
      try {
        const merged = Buffer.from(entry.merged, 'base64')
        if (merged.equals(fs.readFileSync(full))) continue
        // Do NOT write the merge over their file. The merge was computed
        // against the server's view of this path, not against the bytes on
        // this disk, and the person owning this checkout is editing it — that
        // is why there is a conflict at all. Writing here discards whatever
        // they have typed since the push went out. On 2026-08-17 this replaced
        // voice-dictated text four times in one session.
        //
        // The merged content is on the server and stays retrievable; the
        // conflict is reported below and through the source-sync status.
        written.push(entry.path)
      } catch (e) {
        // Keep going so one unwritable file doesn't hide the others, but this
        // is not swallowed: a conflict we cannot put in front of the person is
        // the silent divergence this whole path exists to end, so it goes out
        // as a critical warning below.
        failed.push({ path: entry.path, error: e.message })
      }
    }
    if (written.length > 0) {
      log.warn(`${message.project}: conflict on ${written.join(', ')} — your copy is untouched; the merged version is on the server`)
    }
    if (failed.length > 0) {
      const detail = failed.map(f => `${f.path} (${f.error})`).join(', ')
      log.error(`${message.project}: could not write conflict into ${detail}`)
      sendMsg({
        type: 'daemon-warning',
        warning: 'source-conflict-undeliverable',
        severity: 'critical',
        project: message.project,
        message: `Conflict in ${message.project} could not be written to this machine's copy (${detail}). Its edits are diverged and will not sync until this is resolved.`,
      })
    }
    return written
  }

  function handleSourceChangeResult(message) {
    const request = sourceCorrelation.pendingRequest(message.requestId)
    if (!request) {
      // Say which reply was thrown away. Dropping it in silence made a reply that
      // never came and a reply that came under an id we do not hold look
      // identical in the record, and both server replay paths answer with the
      // STORED operation's requestId rather than the live one
      // (server/unified-server.mjs:8871 and :9580) — so a mismatch is a real
      // shape, not a hypothetical. On 2026-08-18 that indistinguishability was
      // most of the 93 minutes nobody could see the wedge.
      log.warn(`dropped source-change-result for ${message.project || 'unknown project'}: requestId ${message.requestId || 'missing'} is not one we have in flight`)
      return false
    }
    const bindingId = request.payload?.sourceBindingId
    if (!message.ok && message.status === 'stale-base' && bindingId && message.authority?.currentRevision) {
      sourceMaterializer.observeServerHead(bindingId, message.authority.currentRevision)
    }
    const conflicted = message?.status === 'stale-base' ? writeConflictsToWorkingCopy(message) : []
    const project = message.project
    const wasBlocked = project ? sourceCorrelation.state(project).blocked : false
    const handled = sourceCorrelation.handle(message)
    if (!handled) return false
    const outboxId = message.outbox_id || request.payload?.[DAEMON_OUTBOX_ID_FIELD]
    const operationIds = (request.payload?.editOperations || (request.payload?.editOperation ? [{ operation: request.payload.editOperation }] : [])).map(record => record.operation?.operation_id).filter(Boolean)
    if (message.ok) {
      sourceCorrelation.settleOperations(message.project, operationIds)
      if (bindingId && message.sourceRevision) sourceMaterializer.acceptLocalRevision(bindingId, message.sourceRevision)
    }
    if (conflicted.length > 0) sourceCorrelation.holdForHuman(message.project)
    if (editOperationStore && outboxId && operationIds.length) {
      if (message.ok) editOperationStore.applyDisposition({ outboxId, kind: 'accepted', operationIds })
      else if (conflicted.length) editOperationStore.applyDisposition({ outboxId, kind: 'retired', operationIds, reason: 'conflict-human-handoff' })
      else if (message.status !== 'stale-base' || request.retried) editOperationStore.applyDisposition({ outboxId, kind: 'retired', operationIds, reason: request.retried ? 'retry-exhausted' : 'permanent-source-rejection' })
    }
    // A stale-base rejection is contention, not an incident: the daemon retries it
    // once immediately and then on the self-heal backoff, and `raiseBlockedStatus`
    // is what tells the author — once per episode, when the block is actually
    // entered. Warning here as well would fire on every rejection, which is how a
    // recoverable base collision came to look like a failed save.
    if (!message?.ok && conflicted.length === 0 && message.status !== 'stale-base') {
      const detail = message.error || message.status || 'unknown'
      sendMsg({
        type: 'daemon-warning',
        warning: 'source-change-rejected',
        severity: 'critical',
        project: message.project,
        message: `Source change for ${message.project} was rejected by the server: ${detail}`,
        status: message.status || null,
        httpStatus: message.httpStatus || null,
      })
    }
    let retry
    while ((retry = sourceCorrelation.takeRetry())) {
      if (!retry.retried || !editOperationStore || !outboxId) { sendSourceChange(retry.payload, retry.retried); continue }
      const semanticFingerprint = createHash('sha256').update(JSON.stringify(retry.payload)).digest('hex')
      const retryRequestId = createHash('sha256').update(`source-retry-request\0${outboxId}\0${message.authority?.currentRevision || ''}\0${semanticFingerprint}`).digest('hex')
      const retryOutboxId = createHash('sha256').update(`source-retry-envelope\0${outboxId}\0${retryRequestId}`).digest('hex')
      const payload = { ...retry.payload, requestId: retryRequestId, expectedRevision: message.authority?.currentRevision || null, retryOf: outboxId, [DAEMON_OUTBOX_ID_FIELD]: retryOutboxId }
      const requestFingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      retryFault?.('before-disposition')
      editOperationStore.applyDisposition({ outboxId, kind: 'retry_pending', operationIds, retry: { outboxId: retryOutboxId, requestId: retryRequestId, fingerprint: requestFingerprint, payload } })
      retryFault?.('after-disposition')
      sourceCorrelation.restore(payload)
      sendMsg(payload)
      retryFault?.('after-outbox-insert')
      const row = verifyOutbox(retryOutboxId)
      if (row && createHash('sha256').update(JSON.stringify(row.payload)).digest('hex') === requestFingerprint) {
        editOperationStore.markRetryEnqueued(outboxId)
        retryFault?.('after-retry-enqueued')
      }
    }
    if (project) {
      const nowBlocked = sourceCorrelation.state(project).blocked
      if (!wasBlocked && nowBlocked) {
        // The bounded one-shot retry came back stale-base too, so the project has
        // just entered `blocked`. Re-arm its files and start the self-heal cadence
        // rather than leaving it for a restart to clear.
        deferBlockedProject(project, sourceCorrelation.takeBlockedPayload(project))
      } else if (message.ok && sourceWatchers.get(project)?._blockedStatusRaised) {
        // A submit landed for a project whose alarm is up. The self-heal releases the
        // block at resubmit time, so the flag is already clear by now; the raised
        // alarm is what tells us contention had been holding this project.
        recoverBlockedProject(project)
      }
    }
    return true
  }

  function restoreDurableSourceChange(message) { sourceCorrelation.restore(message) }

  function recoverRetries() {
    for (const disposition of editOperationStore?.pendingRetries?.() || []) {
      sourceCorrelation.restore(disposition.retryPayload)
      sendMsg(disposition.retryPayload)
      const row = verifyOutbox(disposition.retry_outbox_id)
      if (row && createHash('sha256').update(JSON.stringify(row.payload)).digest('hex') === disposition.retry_fingerprint) editOperationStore.markRetryEnqueued(disposition.outbox_id)
    }
  }

  function applyAcceptedSourceUpdate(message = {}) {
    const { project, sourceRevision, previousRevision, sourceManifest = [], baseManifest, targetManifest, blobs } = message
    if (!project) throw new Error('project is required')
    const state = sourceWatchers.get(project)
    if (!state?.sourceDir) return { ok: false, accepted: false, reason: 'project-not-watched' }
    if (message.bindingId !== state.bindingId) return { ok: false, accepted: false, reason: 'binding-not-watched', bindingId: state.bindingId }
    if (!sourceRevision || !Array.isArray(baseManifest) || !Array.isArray(targetManifest) || !blobs || typeof blobs !== 'object') {
      throw new Error('Accepted source materialization requires sourceRevision, baseManifest, targetManifest, and blobs')
    }
    const record = sourceMaterializer.plan({
      bindingId: state.bindingId,
      sourceRevision,
      previousRevision,
      sourceDir: state.sourceDir,
      baseManifest,
      targetManifest,
      blobs,
      outboundPending: [...state.pending],
    })
    let terminal
    try {
      terminal = sourceMaterializer.apply(state.bindingId, sourceRevision)
    } catch (error) {
      sendMsg({
        type: 'daemon-warning',
        warning: 'source-update-undeliverable',
        severity: 'critical',
        project,
        message: `Accepted server source for ${project} could not be materialized in this machine's linked checkout (${error.message}).`,
      })
      throw error
    }
    const conflicted = (terminal.conflicts || []).map(conflict => conflict.path)
    const applied = terminal.paths
      .filter(item => item.state === 'complete' && item.action !== 'unchanged')
      .map(item => item.path)
    for (const item of terminal.paths) {
      const full = path.join(state.sourceDir, item.path)
      state.pathFingerprints.set(full, sourcePathFingerprint(full))
    }
    if (conflicted.length > 0) {
      sourceCorrelation.holdForHuman(project)
      // Say what happened. Nothing writes conflict markers any more —
      // writeConflictsToWorkingCopy and the materializer both deliberately leave
      // the person's file alone — so telling them to resolve markers sends them
      // looking for text that is not in the file.
      log.warn(`${project}: server source diverged from this checkout in ${conflicted.join(', ')} — your copy was not modified and no conflict markers were written; the server's version is on the server`)
      return { ok: false, accepted: true, reason: 'conflicted', sourceRevision, applied, conflicted }
    }
    if (Array.isArray(sourceManifest)) state.authorityManifest = new Set(sourceManifest)
    return { ok: true, accepted: true, bindingId: state.bindingId, sourceRevision, materializedRevision: sourceRevision, applied, conflicted }
  }

  // Re-arm the files an edit could not submit, raise the visible status, and
  // (re)start the retry cadence. Re-arming the file PATHS rather than replaying the
  // queued payload's bytes is the whole point: the eventual resubmit reads the
  // newest local edit, so an older queued write can never overwrite a newer one.
  function deferBlockedProject(project, payload) {
    const state = sourceWatchers.get(project)
    if (state) {
      for (const file of payload?.files || []) { if (file?.path) state.pending.add(file.path) }
      for (const rel of payload?.deletedFiles || []) { if (rel) state.pending.add(rel) }
    }
    raiseBlockedStatus(project)
    scheduleBlockedRetry(project)
  }

  // Surface the block on the supported per-doc status path: a critical
  // daemon-warning raises the SyncErrorPill through the convergent sentinel, so it
  // survives a reconnect, rather than living in a log nobody reads. One alarm per
  // block episode — the server dedups repeats, and the daemon does not re-raise.
  function raiseBlockedStatus(project) {
    const state = sourceWatchers.get(project)
    if (state?._blockedStatusRaised) return
    if (state) state._blockedStatusRaised = true
    sendMsg({
      type: 'daemon-warning',
      project,
      severity: 'critical',
      message: 'Source edits are paused: the document base changed on the server (another editor or machine). Your edits are queued and retrying automatically — nothing is lost.',
    })
  }

  function scheduleBlockedRetry(project) {
    const state = sourceWatchers.get(project)
    if (!state) return
    if (state._blockedRetryTimer) return // exactly one in-flight self-heal per project
    const attempt = state._blockedRetryAttempt || 0
    const delay = Math.min(BLOCKED_RETRY_BASE_MS * (2 ** attempt), BLOCKED_RETRY_MAX_MS)
    const timer = setTimeout(() => {
      state._blockedRetryTimer = null
      if (sourceWatchers.get(project) !== state) return
      state._blockedRetryAttempt = attempt + 1
      // Release the block, then flush: the flush re-reads current disk bytes and
      // coalesces every edit queued during the backoff into ONE payload — no stale
      // overwrite, one request in flight. The resubmit rides the base the daemon
      // learned from the rejection (observeServerHead), so it races the server's
      // refreshed authority rather than replaying the one that was refused. If it
      // comes back stale-base again, handleSourceChangeResult re-defers with a
      // longer backoff and the alarm stays up until a clean submit clears it.
      sourceCorrelation.unblock(project)
      flushSourceChanges(project)
    }, delay)
    timer.unref?.()
    state._blockedRetryTimer = timer
  }

  function recoverBlockedProject(project) {
    const state = sourceWatchers.get(project)
    if (state) {
      state._blockedStatusRaised = false
      state._blockedRetryAttempt = 0
      if (state._blockedRetryTimer) { clearTimeout(state._blockedRetryTimer); state._blockedRetryTimer = null }
    }
    // Lower the per-doc sync alarm on the same status path that raised it.
    sendMsg({ type: 'daemon-sync-ok', project })
  }

  function loadSourceBindings() {
    try {
      if (!fs.existsSync(sourceBindingsFile)) return {}
      const stored = JSON.parse(fs.readFileSync(sourceBindingsFile, 'utf8')) || {}
      return Object.fromEntries(Object.entries(stored).map(([project, value]) => {
        const sourceDir = path.resolve(typeof value === 'string' ? value : value.sourceDir)
        const bindingId = typeof value === 'object' && typeof value.bindingId === 'string'
          ? value.bindingId
          : createHash('sha256').update(`source-binding\0${project}\0${sourceDir}`).digest('hex')
        return [project, { bindingId, project, sourceDir }]
      }))
    } catch (e) {
      log.warn(`corrupt source-bindings file, ignoring: ${e.message}`)
      return {}
    }
  }

  function boundProjectNames() {
    return Object.keys(loadSourceBindings()).sort()
  }

  function bindingRecords() {
    return Object.values(loadSourceBindings()).sort((a, b) => a.bindingId.localeCompare(b.bindingId))
  }

  function saveSourceBindings(bindings) {
    fs.mkdirSync(path.dirname(sourceBindingsFile), { recursive: true })
    const pending = `${sourceBindingsFile}.pending-${process.pid}-${randomUUID()}`
    fs.writeFileSync(pending, `${JSON.stringify(bindings, null, 2)}\n`)
    const pendingFd = fs.openSync(pending, 'r')
    try { fs.fsyncSync(pendingFd) } finally { fs.closeSync(pendingFd) }
    fs.renameSync(pending, sourceBindingsFile)
    const targetFd = fs.openSync(sourceBindingsFile, 'r')
    try { fs.fsyncSync(targetFd) } finally { fs.closeSync(targetFd) }
    const parentFd = fs.openSync(path.dirname(sourceBindingsFile), 'r')
    try { fs.fsyncSync(parentFd) } finally { fs.closeSync(parentFd) }
  }

  function bindSource(project, sourceDir) {
    const normalized = path.resolve(sourceDir)
    if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
      throw new Error(`Source directory does not exist: ${normalized}`)
    }
    const bindings = loadSourceBindings()
    const existing = bindings[project] || null
    if (existing?.sourceDir === normalized) return { linked: false, alreadyLinked: true, bindingId: existing.bindingId, sourceDir: normalized }
    if (existing) {
      throw new Error(`Project "${project}" is already linked to ${existing.sourceDir}; unlink it first`)
    }
    bindings[project] = { bindingId: randomUUID(), project, sourceDir: normalized }
    saveSourceBindings(bindings)
    sourceMaterializer.seedBinding(bindings[project].bindingId, normalized, null)
    return { linked: true, alreadyLinked: false, bindingId: bindings[project].bindingId, sourceDir: normalized }
  }

  /**
   * Answer "would binding this project to this directory be a no-op, a new
   * link, or a conflict?" without writing anything.
   *
   * This exists so a caller that must do fallible work BEFORE the link is real
   * — offering the project's version history to the server it is moving to —
   * can ask the question first and write only once the work has succeeded. The
   * alternative is binding up front and unbinding on failure, which leaves a
   * window where a binding names a project the server does not have. That is
   * not hypothetical: a link to `stable` on 2026-08-12 failed and left exactly
   * that row behind in `source-bindings.stable.json`.
   *
   * Throws on conflict, so the caller gets today's error at today's moment.
   */
  function bindingStatus(project, sourceDir) {
    const normalized = path.resolve(sourceDir)
    const existing = loadSourceBindings()[project]
    const resolved = existing?.sourceDir || null
    if (resolved && resolved !== normalized) {
      throw new Error(`Project "${project}" is already linked to ${resolved}; unlink it first`)
    }
    return { alreadyLinked: resolved === normalized, bindingId: existing?.bindingId || null, sourceDir: normalized }
  }

  function unbindSource(project, expectedSourceDir = null) {
    const bindings = loadSourceBindings()
    if (!bindings[project]) return { unlinked: false, alreadyUnlinked: true }
    const { bindingId, sourceDir } = bindings[project]
    if (expectedSourceDir && sourceDir !== path.resolve(expectedSourceDir)) {
      throw new Error(`Project "${project}" is linked to ${sourceDir}, not ${path.resolve(expectedSourceDir)}`)
    }
    delete bindings[project]
    saveSourceBindings(bindings)
    return { unlinked: true, alreadyUnlinked: false, bindingId, sourceDir }
  }

  // ---------- source watching ----------

  const JUNK_PATTERNS = [/^\.#/, /\.swp$/, /~$/, /\.tmp$/, /\.lock$/]

  // Bootstrap input scanner — regex-scan .tex files for \input-like commands
  // to discover dependencies before the first successful build produces a .fls.
  const DEFAULT_INPUT_COMMANDS = ['input', 'include', 'inputscratch', 'addbibresource', 'bibliography', 'usepackage', 'includegraphics']
  const GRAPHICS_EXTENSIONS = ['.pdf', '.svg', '.png', '.jpg', '.jpeg', '.eps']

  function scanTexInputs(sourceDir, mainFile, extraCommands = []) {
    const commands = [...DEFAULT_INPUT_COMMANDS, ...extraCommands]
    const pattern = new RegExp(`\\\\(${commands.join('|')})(?:\\[[^\\]]*\\])?\\{([^}]+)\\}`, 'g')
    const seen = new Set()
    const result = new Set()

    function scan(relPath) {
      if (seen.has(relPath)) return
      seen.add(relPath)
      const full = path.join(sourceDir, relPath)
      if (!fs.existsSync(full)) return
      let stat
      try { stat = fs.statSync(full) } catch { return }
      if (!stat.isFile()) return
      result.add(relPath)

      const ext = path.extname(relPath).toLowerCase()
      if (ext !== '.tex' && ext !== '.sty' && ext !== '.cls') return

      let content
      try { content = fs.readFileSync(full, 'utf8') } catch { return }
      for (const m of content.matchAll(pattern)) {
        const cmd = `\\${m[1]}`
        const raw = m[2].trim()
        if (!raw) continue
        // \usepackage and \bibliography accept comma-separated lists
        const refs = (cmd === '\\usepackage' || cmd === '\\bibliography')
          ? raw.split(',').map(s => s.trim()).filter(Boolean)
          : [raw]
        for (let ref of refs) {
          if (cmd === '\\usepackage') {
            if (!ref.endsWith('.sty')) ref += '.sty'
          } else if (cmd === '\\bibliography' || cmd === '\\addbibresource') {
            if (!ref.endsWith('.bib')) ref += '.bib'
          } else if (cmd === '\\includegraphics') {
            const ext = path.extname(ref).toLowerCase()
            const candidates = ext ? [ref] : GRAPHICS_EXTENSIONS.map(suffix => ref + suffix)
            if (ext === '.pdf') candidates.push(ref.slice(0, -ext.length) + '.svg')
            const dir = path.dirname(relPath)
            for (const candidate of candidates) {
              const resolved = path.normalize(path.join(dir, candidate))
              if (resolved.startsWith('..') || path.isAbsolute(resolved)) continue
              if (fs.existsSync(path.join(sourceDir, resolved))) result.add(resolved)
            }
            continue
          } else if (!path.extname(ref)) {
            ref += '.tex'
          }
          const dir = path.dirname(relPath)
          const resolved = path.normalize(path.join(dir, ref))
          if (resolved.startsWith('..')) continue
          scan(resolved)
          if (cmd === '\\inputscratch' && resolved.endsWith('.tex')) {
            const mdCompanion = resolved.replace(/\.tex$/, '.md')
            if (fs.existsSync(path.join(sourceDir, mdCompanion))) result.add(mdCompanion)
          }
        }
      }
    }

    scan(mainFile)
    return result
  }

  // Markdown scope is the transitive closure rooted at mainFile. Linked Markdown
  // files remain separate documents, but their bytes and local assets belong to
  // the same project version and watcher set.
  function scanMarkdownInputs(sourceDir, mainFile) {
    return new Set(scanMarkdownDependencyClosure(mainFile, sourceDir).files)
  }

  function scanReferencedInputs(sourceDir, sourcePaths = []) {
    const roots = new Set()
    const reached = new Set()
    for (const sourcePath of sourcePaths || []) {
      const rel = sourceRel(sourceDir, sourcePath)
      if (!rel) continue
      roots.add(rel)
      reached.add(rel)
      if (!/\.(?:md|markdown)$/i.test(rel)) continue
      try {
        for (const dependency of scanMarkdownDependencyClosure(rel, sourceDir).files) reached.add(dependency)
      } catch {
        // The root stays watched so creating or repairing it can make the closure readable.
      }
    }
    return { roots, reached }
  }

  // A markdown doc bundles only its dependency graph (main + linked documents
  // and supported assets), never the
  // rest of sourceDir — so the "any source file always passes" escape hatch must
  // not apply to it.
  function isMarkdownDoc(format, mainFile) {
    return format === 'markdown' || (mainFile?.toLowerCase().endsWith('.md') ?? false)
  }

  function isSourceFile(name, context = {}) {
    if (JUNK_PATTERNS.some(r => r.test(name))) return false
    if (name.includes('node_modules') || name.includes('.git/')) return false
    return isSourceFilePath(name, context)
  }

  function readFileForUpload(fullPath) {
    const data = fs.readFileSync(fullPath)
    // Heuristic: text-y if mostly ASCII; otherwise base64.
    const ext = path.extname(fullPath).toLowerCase()
    const TEXT_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.md', '.qmd', '.html', '.css', '.js', '.svg', '.json', '.yml', '.yaml'])
    if (TEXT_EXTS.has(ext)) return { content: data.toString('utf8') }
    return { content: data.toString('base64'), encoding: 'base64' }
  }

  function sourceRel(sourceDir, filePath) {
    if (!filePath) return null
    const abs = path.isAbsolute(String(filePath)) ? String(filePath) : path.join(sourceDir, String(filePath))
    const rel = path.relative(sourceDir, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join('/')
  }

  // Build output records authoring files as absolute paths. The daemon, on the
  // other hand, keeps its watch set and source-change payloads relative to the
  // project source root. Leaving those absolute entries untouched makes
  // sourceWatcherPaths join them onto sourceDir and the markdown part is never
  // watched. Normalize at the boundary so a project part such as
  // scratch/report.md is watched and uploaded under that same project path.
  function normalizeWatchSet(sourceDir, watchFiles) {
    const normalized = new Set()
    for (const file of watchFiles || []) {
      const rel = sourceRel(sourceDir, file)
      if (rel) normalized.add(rel)
    }
    return normalized
  }

  function closeWatcher(watcher, label) {
    if (!watcher) return
    try {
      const closed = watcher.close()
      if (closed?.catch) closed.catch(e => log.warn(`chokidar close failed for ${label}: ${e?.message || e}`))
    } catch (e) {
      // Watcher shutdown is cleanup-only; log and continue tearing down peers.
      log.warn(`chokidar close threw for ${label}: ${e?.message || e}`)
    }
  }

  function shouldIgnoreSourceWatchPath(sourceDir, filePath, stats, context = {}) {
    const rel = sourceRel(sourceDir, filePath)
    if (!rel) return false
    const parts = rel.split('/')
    if (parts.includes('node_modules') || parts.includes('.git')) return true
    if (!stats) return false
    if (stats?.isDirectory?.()) return false
    return !isSourceFile(rel, context) && !rel.includes('.tlda/scratch/')
  }

  function collectSourceManifest(sourceDir, context, watchSet = null, authorityManifest = null, sendingPaths = null) {
    const authority = new Set(Array.isArray(authorityManifest) ? authorityManifest : [])
    const rels = new Set(authority)
    if (watchSet) {
      for (const rel of watchSet) {
        if (typeof rel !== 'string') continue
        if (fs.existsSync(path.join(sourceDir, rel))) rels.add(rel)
      }
      return normalizeSourceManifest([...rels], context)
    }

    function walk(dir, prefix = '') {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (isIgnoredSourceDir(entry.name)) continue
          walk(full, rel)
        } else if (!isBuildJunkPath(rel) && isSourceFile(rel, context)) {
          rels.add(rel)
        }
      }
    }
    walk(sourceDir)

    // A walk implies existence, which was true until the gap between walking and
    // the server validating got long enough to matter.
    //
    // For a slides or html project every file under the source dir is source
    // (shared/source-manifest.mjs, deliberately — there is no reference graph
    // that reveals the set), so quarto's scratch is walked in: project-cache,
    // quarto-session-temp<random>, and their SQLite -shm/-wal companions. Quarto
    // makes and unmakes those during a render. One that dies inside the gap is
    // declared here and gone when the server checks, so it is `extra` and the
    // whole push is rejected — a different file each render, which is why it
    // reads as intermittent and unfixable. Observed live:
    // `nonexistent authored file: .quarto/project-cache/deno-kv-file-shm`.
    //
    // Re-checking existence stays true when quarto changes its scratch layout,
    // which enumerating its temp directories would not.
    //
    // Two things are never dropped, and both are needed:
    //
    //   authority   — the set the server already holds. Undeclaring one of these
    //                 fails the mirror test, `missing surviving authored file`,
    //                 which is this same wedge pointing the other way. It also
    //                 makes an editor's atomic save safe: a delete-and-recreate
    //                 of a file the server knows stays declared through the gap.
    //   sendingPaths — the files in THIS push. Undeclaring one of those fails
    //                 `sourceManifest missing pushed file`. A file can be read
    //                 into the payload and vanish before this walk; it must stay
    //                 declared because we are still sending it.
    const keep = new Set(Array.isArray(sendingPaths) ? sendingPaths : [])
    for (const rel of [...rels]) {
      if (authority.has(rel) || keep.has(rel)) continue
      if (!fs.existsSync(path.join(sourceDir, rel))) rels.delete(rel)
    }

    return normalizeSourceManifest([...rels], context)
  }

  function sourceWatcherPaths(state) {
    const rels = new Set(state.watchSet || [])
    if (state.mainFile) rels.add(state.mainFile)
    const paths = []
    for (const rel of rels) {
      if (!rel || typeof rel !== 'string') continue
      const normalized = rel.split(/[\\/]+/).filter(Boolean).join(path.sep)
      if (!normalized) continue
      const full = path.join(state.sourceDir, normalized)
      paths.push(full)
    }
    paths.sort()
    return paths
  }

  function sourceWatcherKey(state) {
    return sourceWatcherPaths(state).join('\0')
  }

  function sourcePathFingerprint(filePath) {
    try {
      const stat = fs.statSync(filePath, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    } catch (error) {
      if (error?.code === 'ENOENT') return 'missing'
      return `error:${error?.code || error?.message || 'unknown'}`
    }
  }

  // A source-change whose reply never comes used to pin its project forever.
  // Expiry is deliberately LOUD: the give-up path this sits beside dead-lettered
  // three of his edits at 18:47:24Z on 2026-08-17 with nothing in the log and
  // nothing on screen, and a wire that reports health while it is severed is the
  // failure this whole path exists to end. So every expiry goes to log.error AND
  // raises the critical daemon-warning that lights the SyncErrorPill.
  function expireStaleSourceRequests() {
    for (const expiry of sourceCorrelation.expireStalePending(sourceChangeSettleDeadlineMs)) {
      const waited = Math.round(expiry.waitedMs / 1000)
      log.error(`source change for ${expiry.project} got no reply in ${waited}s (requestId ${expiry.requestIds.join(', ') || 'none'}); releasing the project so later edits can be sent`)
      sendMsg({
        type: 'daemon-warning',
        warning: 'source-change-unanswered',
        severity: 'critical',
        project: expiry.project,
        message: `A source push for ${expiry.project} was never answered by the server (waited ${waited}s). Edits made since then were held and are being sent now; if this repeats, this machine's edits are not reaching the server.`,
      })
      if (expiry.queuedPayload) sendSourceChange(expiry.queuedPayload)
    }
  }

  function reconcileSourceWatcher(state) {
    if (sourceWatchers.get(state.projectName) !== state) return
    expireStaleSourceRequests()
    const nextPaths = sourceWatcherPaths(state)
    const next = new Map()
    for (const filePath of nextPaths) {
      const fingerprint = sourcePathFingerprint(filePath)
      next.set(filePath, fingerprint)
      const previous = state.pathFingerprints.get(filePath)
      if (previous !== undefined && previous !== fingerprint) {
        const rel = sourceRel(state.sourceDir, filePath)
        if (rel) {
          log.warn(`source reconciliation detected missed watcher edge for ${state.projectName}: ${rel}`)
          state.onFileChange(rel)
        }
      }
    }
    for (const filePath of state.pathFingerprints.keys()) {
      if (next.has(filePath)) continue
      const rel = sourceRel(state.sourceDir, filePath)
      if (rel) state.onFileChange(rel)
    }
    state.pathFingerprints = next
  }

  function startSourceWatcher(state, reason = 'start') {
    closeWatcher(state.watcher, state.projectName)
    const watchPaths = sourceWatcherPaths(state)
    state.watcherKey = watchPaths.join('\0')
    if (watchPaths.length === 0) {
      state.watcher = null
      log.warn(`source watcher disabled for ${state.projectName}: no bounded source files to watch`)
      return
    }
    const watcher = watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: true,
      ignored: (filePath, stats) => shouldIgnoreSourceWatchPath(
        state.sourceDir,
        filePath,
        stats,
        { format: state.format, mainFile: state.mainFile, referencedRoots: state.referencedRoots },
      ),
    })
    state.watcher = watcher
    state.pathFingerprints = new Map(watchPaths.map(filePath => [filePath, sourcePathFingerprint(filePath)]))
    const handle = (filePath) => {
      if (state.watcher !== watcher) return
      const rel = sourceRel(state.sourceDir, filePath)
      const fingerprint = sourcePathFingerprint(filePath)
      const targetHash = fs.existsSync(filePath) ? createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') : null
      if (rel && sourceMaterializer.consumeCompletedPath(state.bindingId, rel, targetHash)) {
        state.pathFingerprints.set(filePath, fingerprint)
        return
      }
      state.pathFingerprints.set(filePath, fingerprint)
      if (rel) state.onFileChange(rel)
    }
    watcher
      .on('add', handle)
      .on('change', handle)
      .on('unlink', handle)
      .on('error', e => {
        if (state.watcher !== watcher) return
        log.warn(`chokidar source watcher failed for ${state.projectName}: ${e?.message || e}`)
        state.watcher = null
        closeWatcher(watcher, state.projectName)
        setTimeout(() => {
          if (sourceWatchers.get(state.projectName) === state && !state.watcher) startSourceWatcher(state, 'retry')
        }, 1000).unref?.()
      })
    log.info(`chokidar source watcher started for ${state.projectName} (${reason}, ${watchPaths.length} paths)`)
  }

  function closeSourceState(state) {
    closeWatcher(state.watcher, state.projectName)
    state.watcher = null
    if (state.reconcileTimer) clearInterval(state.reconcileTimer)
    state.reconcileTimer = null
    if (state._blockedRetryTimer) { clearTimeout(state._blockedRetryTimer); state._blockedRetryTimer = null }
    if (state._symlinkWatchers) {
      for (const [target, watcher] of state._symlinkWatchers) closeWatcher(watcher, `symlink target ${target}`)
      state._symlinkWatchers.clear()
    }
  }

  // Anything the SERVER says it holds that is not on disk has to be deleted on
  // the server. Nothing else in this file can do it: the watcher only reports
  // paths it watches, and a file that was deleted before the daemon started --
  // or that is outside the watch set, like a dotfile -- is never reported at
  // all. So the phantom sits in the server's manifest forever and every push is
  // refused with `sourceManifest contains nonexistent authored file`.
  //
  // That is not hypothetical. `.bak-before-deletion.tex` did exactly this to
  // bregman: deleted locally, kept by the server, and from 2026-08-07 every
  // push Skip made was refused for eleven days. It was still refusing at
  // 04:43 on 2026-08-18.
  //
  // Queue them as pending. flushSourceChanges puts any pending path that does
  // not exist into `deletedFiles`, so this becomes a real deletion rather than
  // the daemon quietly forgetting the server disagrees with it.
  function queueServerHeldButMissing(state) {
    let queued = 0
    for (const rel of state.authorityManifest) {
      if (fs.existsSync(path.join(state.sourceDir, rel))) continue
      state.pending.add(rel)
      queued += 1
    }
    if (queued > 0) {
      log.info(`${state.projectName}: ${queued} file(s) the server holds are gone from disk; sending deletions`)
      clearTimeout(state.debounce)
      state.debounce = setTimeout(() => flushSourceChanges(state.projectName), 200)
    }
    return queued
  }

  function sync(projectList, { authoritativeRevisions = false } = {}) {
    const activeNames = new Set()
    const bindings = loadSourceBindings()
    for (const p of projectList) {
      const binding = bindings[p.name]
      const sourceDir = binding?.sourceDir
      if (!sourceDir) continue
      if (!fs.existsSync(sourceDir)) continue
      const durableBinding = sourceMaterializer.seedBinding(binding.bindingId, sourceDir, p.sourceRevision || null)
      activeNames.add(p.name)

      const isMarkdown = isMarkdownDoc(p.format, p.mainFile)
      const hasFlsWatchList = p.watchFiles?.length > 0
      // Bootstrap watchSet (no .fls yet) must include the main's \input deps, not
      // just the main, so the initial connect push contains dependencies before
      // the first build produces a .fls.
      const declaredWatchSet = new Set(
        isMarkdown && p.mainFile ? scanMarkdownInputs(sourceDir, p.mainFile)
        : p.mainFile ? scanTexInputs(sourceDir, p.mainFile, p.extraInputCommands || []) : []
      )
      const projectWatchSet = hasFlsWatchList
        ? new Set([...normalizeWatchSet(sourceDir, p.watchFiles), ...declaredWatchSet])
        : declaredWatchSet
      const referenced = scanReferencedInputs(sourceDir, p.referencedSourcePaths)
      const watchSet = new Set([...projectWatchSet, ...referenced.reached])

      if (sourceWatchers.has(p.name)) {
        const existing = sourceWatchers.get(p.name)
        if (existing.sourceDir !== sourceDir) {
          closeSourceState(existing)
          sourceWatchers.delete(p.name)
        } else {
          const previousReferenced = new Set(existing.referencedRoots || [])
          existing.watchSet = watchSet
          existing.projectWatchSet = projectWatchSet
          existing.chatReferenceRoots = referenced.roots
          existing.referencedRoots = referenced.reached
          existing.mainFile = p.mainFile
          existing.extraInputCommands = p.extraInputCommands || []
          existing.isMarkdown = isMarkdown
          existing.format = p.format
          existing.authorityManifest = new Set(Array.isArray(p.sourceManifest) ? p.sourceManifest : [])
          existing.bindingId = binding.bindingId
          queueServerHeldButMissing(existing)
          const nextWatcherKey = sourceWatcherKey(existing)
          if (!existing.watcher || existing.watcherKey !== nextWatcherKey) startSourceWatcher(existing, 'resync')
          for (const rel of referenced.reached) {
            if (!previousReferenced.has(rel)) existing.onFileChange(rel)
          }
          continue
        }
      }

      const state = { bindingId: binding.bindingId, sourceDir, debounce: null, pending: new Set(), watchSet, projectWatchSet, chatReferenceRoots: referenced.roots, referencedRoots: referenced.reached, authorityManifest: new Set(Array.isArray(p.sourceManifest) ? p.sourceManifest : []), onFileChange: null, projectName: p.name, mainFile: p.mainFile, format: p.format, extraInputCommands: p.extraInputCommands || [], isMarkdown, watcher: null, watcherKey: '', pathFingerprints: new Map(), reconcileTimer: null, _symlinkWatchers: new Map() }

      const onFileChange = (filename) => {
        if (!filename) return
        if (fs.existsSync(path.join(state.sourceDir, filename))) state.authorityManifest.add(filename)
        else state.authorityManifest.delete(filename)
        if (state.isMarkdown) {
          // A markdown doc bundles exactly its dependency graph (main + referenced
          // images). Enforce the watchSet strictly — do NOT let arbitrary source
          // files in sourceDir through, or the doc eats the whole dir's churn.
          // Newly-referenced images are discovered by rescanning when the main .md
          // changes (see flushSourceChanges), not via the escape hatch below.
          if (!state.watchSet.has(filename)) return
        } else {
          const isScratch = filename.includes('.tlda/scratch/')
          if (!isScratch) {
            // Source files (.tex, .bib, .sty, etc.) always pass - even if not in the watchSet.
            // The watchSet comes from the PREVIOUS build's .fls; a newly-added \input dep
            // won't be in it yet, but we must still push it so the build can pick it up.
            // Non-source files (build artifacts, .aux, etc.) are filtered by watchSet when
            // available, or dropped entirely when the watchSet is empty (bootstrap mode).
            if (!isSourceFile(filename, { format: state.format, mainFile: state.mainFile, referencedRoots: state.referencedRoots })) {
              if (state.watchSet.size > 0) {
                if (!state.watchSet.has(filename)) return
              } else {
                return
              }
            }
          }
        }
        state.pending.add(filename)
        if (state.debounce) clearTimeout(state.debounce)
        state.debounce = setTimeout(() => flushSourceChanges(state.projectName), 200)
      }
      state.onFileChange = onFileChange

      try {
        sourceWatchers.set(p.name, state)
        startSourceWatcher(state, 'project sync')
        queueServerHeldButMissing(state)
        state.reconcileTimer = setInterval(() => reconcileSourceWatcher(state), reconcileIntervalMs)
        state.reconcileTimer.unref?.()
        log.info(`watching source ${p.name}: ${sourceDir}${bindings[p.name] ? ' (local binding)' : ''} (${watchSet.size} files${hasFlsWatchList ? '' : ', bootstrap'})`)
      } catch (e) {
        // One source watcher failing should not stop other projects from syncing.
        log.error(`source watcher failed for ${p.name}: ${e.message}`)
      }
    }
    for (const [name, state] of sourceWatchers) {
      if (!activeNames.has(name)) {
        closeSourceState(state)
        sourceWatchers.delete(name)
      }
    }
  }

  const _pendingSourceProjects = new Set()

  function flushSourceChanges(projectName) {
    const state = sourceWatchers.get(projectName)
    if (!state) return
    state.debounce = null

    if (!isConnected()) {
      _pendingSourceProjects.add(projectName)
      return
    }

    const filePaths = [...state.pending]
    state.pending.clear()
    _pendingSourceProjects.delete(projectName)

    const files = []
    const deleted = []
    for (const rel of filePaths) {
      const full = path.join(state.sourceDir, rel)
      if (!fs.existsSync(full)) { deleted.push(rel); continue }
      // Resolve symlinks so the server stores files at their canonical path.
      // Fixes the case where .tlda/scratch/ is a directory symlink (e.g. pointing
      // to revision/.tlda/scratch/) — without this the daemon pushes
      // .tlda/scratch/file.tex but the build expects revision/.tlda/scratch/file.tex.
      let pushPath = rel
      try {
        const realFull = fs.realpathSync(full)
        if (realFull !== full) {
          const canonical = path.relative(state.sourceDir, realFull)
          if (!canonical.startsWith('..')) {
            pushPath = canonical
            if (canonical !== rel) log.info(`resolved symlink: ${rel} → ${canonical}`)
          }
        }
      } catch {
        // Realpath is advisory; unresolved symlinks still push by original path.
      }
      try { files.push({ path: pushPath, ...readFileForUpload(full) }) }
      catch (e) {
        // Per-file upload failures are surfaced; readable files still push.
        log.error(`read ${full}: ${e.message}`)
      }
    }

    // When a .tex file changes, rescan for new \input deps not yet on the server.
    // This catches newly-added \input{} or \inputscratch{} lines before the build
    // fails with "file not found".
    const changedTexFiles = filePaths.filter(f => f.endsWith('.tex'))
    if (changedTexFiles.length > 0 && state.mainFile) {
      const alreadyPushed = new Set(filePaths)
      const deps = scanTexInputs(state.sourceDir, state.mainFile, state.extraInputCommands)
      for (const rel of deps) {
        if (alreadyPushed.has(rel) || state.watchSet.has(rel)) continue
        const full = path.join(state.sourceDir, rel)
        if (!fs.existsSync(full)) continue
        state.watchSet.add(rel)
        try {
          files.push({ path: rel, ...readFileForUpload(full) })
          log.info(`rescan discovered new dep: ${rel}`)
        } catch (e) {
          // Per-file upload failures are surfaced; readable files still push.
          log.error(`read ${full}: ${e.message}`)
        }
      }
    }

    // A link added or removed in any Markdown document changes the project
    // closure. Recompute it from the main file, add newly reachable bytes, and
    // delete files that are no longer reachable from this immutable version.
    if (state.isMarkdown && state.mainFile && filePaths.some(file => /\.(?:md|markdown)$/i.test(file))) {
      const alreadyPushed = new Set(filePaths)
      const deps = scanMarkdownInputs(state.sourceDir, state.mainFile)
      for (const rel of state.watchSet) {
        // A chat-referenced document is not reachable from the main file and is
        // not supposed to be. It got here because somebody clicked its chip, and
        // it is a second root of the project rather than a leaf of this closure.
        //
        // Deleting it here is what wedged `tlda`: the same push then declares it,
        // because collectSourceManifest takes `watchSet` and the chat-reference
        // rescan below puts it straight back. One path in `deletedFiles` and in
        // `sourceManifest` is refused whole by the server, so every push carrying
        // any Markdown file failed and his edits stopped reaching the paper.
        //
        // The rescan below owns these paths and deletes them on the right
        // condition — no longer reached from the reference roots.
        if (state.referencedRoots.has(rel)) continue
        if (!deps.has(rel) && state.authorityManifest.has(rel) && !deleted.includes(rel)) deleted.push(rel)
      }
      state.watchSet = deps
      // Authority is what the server holds, and the server holds the closure plus
      // the referenced roots — collectSourceManifest declares both. Dropping the
      // roots here would leave the rescan below unable to delete one that really
      // did stop being referenced, since it guards on this set.
      state.authorityManifest = new Set([...deps, ...state.referencedRoots])
      for (const rel of deps) {
        if (alreadyPushed.has(rel)) continue
        const full = path.join(state.sourceDir, rel)
        if (!fs.existsSync(full)) continue
        try {
          files.push({ path: rel, ...readFileForUpload(full) })
          log.info(`md rescan discovered dep: ${rel}`)
        } catch (e) {
          // Per-file upload failures are surfaced; readable files still push.
          log.error(`read ${full}: ${e.message}`)
        }
      }
    }

    if (state.chatReferenceRoots.size > 0 && filePaths.some(file => /\.(?:md|markdown)$/i.test(file))) {
      const alreadyPushed = new Set(filePaths)
      const previous = state.referencedRoots
      const referenced = scanReferencedInputs(
        state.sourceDir,
        [...state.chatReferenceRoots].map(rel => path.join(state.sourceDir, rel)),
      )
      for (const rel of previous) {
        if (!referenced.reached.has(rel) && state.authorityManifest.has(rel) && !deleted.includes(rel)) deleted.push(rel)
      }
      state.chatReferenceRoots = referenced.roots
      state.referencedRoots = referenced.reached
      state.watchSet = new Set([...state.projectWatchSet, ...referenced.reached])
      for (const rel of referenced.reached) {
        if (alreadyPushed.has(rel) || previous.has(rel)) continue
        const full = path.join(state.sourceDir, rel)
        if (!fs.existsSync(full)) continue
        try {
          files.push({ path: rel, ...readFileForUpload(full) })
          log.info(`chat-reference rescan discovered dep: ${rel}`)
        } catch (e) {
          // One unreadable dependency must not suppress the readable files in this push.
          log.error(`read ${full}: ${e.message}`)
        }
      }
    }

    // Watch symlink targets in .tlda/scratch/ — changes to the linked file should
    // trigger a rebuild even when the target sits outside the source dir.
    for (const rel of filePaths) {
      if (!rel.includes('.tlda/scratch/')) continue
      const full = path.join(state.sourceDir, rel)
      try {
        const stat = fs.lstatSync(full)
        if (stat.isSymbolicLink()) {
          const target = fs.realpathSync(full)
          if (!state._symlinkWatchers) state._symlinkWatchers = new Map()
          if (!state._symlinkWatchers.has(target)) {
            const watcher = chokidar.watch(target, { ignoreInitial: true, persistent: true, followSymlinks: true })
              .on('change', () => state.onFileChange(rel))
              .on('unlink', () => state.onFileChange(rel))
              .on('error', e => log.warn(`chokidar symlink target watcher failed for ${target}: ${e?.message || e}`))
            state._symlinkWatchers.set(target, watcher)
            log.info(`watching symlink target: ${target} -> ${rel}`)
          }
        }
      } catch {
        // Symlink target watching is advisory; the source file itself still triggers pushes.
      }
    }

    if (files.length === 0 && deleted.length === 0) return

    const nextWatcherKey = sourceWatcherKey(state)
    if (state.watcherKey !== nextWatcherKey) startSourceWatcher(state, 'dependency rescan')

    // A path cannot be in `deletedFiles` and in `sourceManifest` at once -- the
    // server refuses the whole push. The manifest is built from
    // `authorityManifest`, and collectSourceManifest deliberately never
    // existence-checks an authority entry (undeclaring one the server still
    // holds is the same wedge pointing the other way, `missing surviving
    // authored file`). So the deletion has to be taken out of authority HERE,
    // where we already know the file is going away.
    for (const rel of deleted) state.authorityManifest.delete(rel)

    // Edit attribution: which agent's recent Edit/Write touched a changed file.
    const editors = resolveEditor(filePaths.map(rel => path.join(state.sourceDir, rel))) || []

    sendSourceChange({
      type: 'source-change',
      project: projectName,
      sourceBindingId: state.bindingId,
      expectedRevision: sourceMaterializer.readBinding(state.bindingId)?.serverHeadRevision || null,
      files,
      sourceManifest: collectSourceManifest(
        state.sourceDir,
        { format: state.format, mainFile: state.mainFile, referencedRoots: state.referencedRoots },
        state.isMarkdown ? state.watchSet : null,
        state.isMarkdown ? null : [...state.authorityManifest],
        files.map(f => f.path),
      ),
      ...(deleted.length > 0 && { deletedFiles: deleted }),
      ...(editors.length === 1 ? { editedBy: editors[0].agentId, editOperation: editors[0].operation } : {}),
      ...(editors.length > 1 ? { editOperations: editors.map(editor => ({ agentId: editor.agentId, operation: editor.operation })) } : {}),
    })
  }

  function flushPending() {
    for (const name of _pendingSourceProjects) {
      flushSourceChanges(name)
    }
  }

  function beginReconnect() {
    sourceCorrelation.beginReconnect()
  }

  function finishReconnect() {
    for (const payload of sourceCorrelation.finishReconnect()) sendSourceChange(payload)
  }


  function getSourceDir(project) {
    const watched = sourceWatchers.get(project)?.sourceDir
    if (watched) return watched
    return loadSourceBindings()[project]?.sourceDir || null
  }

  function sourceFileForAbsolutePath(filePath) {
    return resolveWatchedSourceFile(sourceWatchers, filePath)
  }

  function closeAll() {
    for (const [, state] of sourceWatchers) closeSourceState(state)
    sourceWatchers.clear()
  }

  return {
    bindSource,
    bindingStatus,
    bindingRecords,
    boundProjectNames,
    unbindSource,
    sync,
    beginReconnect,
    finishReconnect,
    flushPending,
    getSourceDir,
    sourceFileForAbsolutePath,
    applyAcceptedSourceUpdate,
    closeAll,
    handleSourceChangeResult,
    restoreDurableSourceChange,
    recoverRetries,
  }
}
