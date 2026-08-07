import { createHash, randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { relative } from 'path'
import { diff } from 'node:util'
import { projectDir, readProject, sourceLifecycleStore, getProjectsDir, listProjects } from './project-store.mjs'
import { readShadowChangelog } from './shadow-changelog.mjs'

const SCHEMA_VERSION = 1
const ACTIVE_PENDING_STATES = new Set(['pending', 'ambiguous'])

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function stableId(prefix, value) {
  return `${prefix}-${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 24)}`
}

function nowIso() {
  return new Date().toISOString()
}

function editEventsDir(name) {
  return `${projectDir(name)}/edit-events`
}

function jsonlPath(name, file) {
  return `${editEventsDir(name)}/${file}.jsonl`
}

function appendJsonl(name, file, record) {
  mkdirSync(editEventsDir(name), { recursive: true })
  appendFileSync(jsonlPath(name, file), `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    created_at: nowIso(),
    ...record,
  })}\n`)
}

function readJsonl(name, file) {
  const path = jsonlPath(name, file)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function decodeSnapshotFile(file) {
  if (!file) return null
  return Buffer.from(file.content || '', 'base64')
}

function snapshotFileMap(snapshot) {
  return new Map((snapshot?.files || []).map(file => [file.path, decodeSnapshotFile(file)]))
}

function sha256(value) {
  if (value == null) return null
  return createHash('sha256').update(value).digest('hex')
}

function textOrNull(buf) {
  if (buf == null || buf.includes(0)) return null
  return buf.toString('utf8')
}

function lineDiffHunks(beforeValue, afterValue) {
  const beforeText = textOrNull(beforeValue)
  const afterText = textOrNull(afterValue)
  if (beforeText == null || afterText == null) return []
  const beforeLines = beforeText.split('\n')
  const afterLines = afterText.split('\n')
  const hunks = []
  let oldLine = 1
  let newLine = 1
  let current = null

  function finish() {
    if (!current) return
    current.old_lines = current.removed.length
    current.new_lines = current.added.length
    current.before_text = current.removed.join('\n')
    current.after_text = current.added.join('\n')
    current.patch = [
      `@@ -${current.old_start},${current.old_lines} +${current.new_start},${current.new_lines} @@`,
      ...current.removed.map(line => `-${line}`),
      ...current.added.map(line => `+${line}`),
    ].join('\n')
    delete current.removed
    delete current.added
    hunks.push(current)
    current = null
  }

  for (const [kind, line] of diff(beforeLines, afterLines)) {
    if (kind === 0) {
      finish()
      oldLine += 1
      newLine += 1
      continue
    }
    current ||= { old_start: oldLine, new_start: newLine, removed: [], added: [] }
    if (kind === -1) {
      current.removed.push(line)
      oldLine += 1
    } else if (kind === 1) {
      current.added.push(line)
      newLine += 1
    }
  }
  finish()
  return hunks
}

function changedFilesFromSnapshots(beforeSnapshot, afterSnapshot, requestedFiles = [], deletedFiles = []) {
  const before = snapshotFileMap(beforeSnapshot)
  const after = snapshotFileMap(afterSnapshot)
  const paths = new Set([
    ...requestedFiles.map(file => file?.path).filter(Boolean),
    ...deletedFiles.filter(Boolean),
  ])
  if (paths.size === 0) {
    for (const path of before.keys()) if (!after.has(path) || !before.get(path).equals(after.get(path))) paths.add(path)
    for (const path of after.keys()) if (!before.has(path)) paths.add(path)
  }
  return [...paths].sort().map(path => {
    const beforeContent = before.get(path) ?? null
    const afterContent = after.get(path) ?? null
    return {
      path,
      before_hash: sha256(beforeContent),
      after_hash: sha256(afterContent),
      hunks: lineDiffHunks(beforeContent, afterContent),
    }
  }).filter(file => file.before_hash !== file.after_hash)
}

function normalizeOrigin(body = {}) {
  if (body.overleafSync) return 'overleaf'
  if (body.sourceDaemonKey) return 'daemon'
  return 'yjs'
}

function sourceIdentityFor(body = {}) {
  if (body.sourceIdentity) return body.sourceIdentity
  if (body.overleafSync) {
    return {
      kind: 'git-remote',
      remote: body.overleafRemote || null,
      commits: Array.isArray(body.overleafCommits) ? body.overleafCommits.map(commit => commit.hash) : [],
    }
  }
  if (body.sourceDaemonKey) {
    return {
      kind: 'daemon',
      daemon_key: body.sourceDaemonKey,
      machine_id: body.sourceMachineId || null,
      env_name: body.sourceEnvName || null,
    }
  }
  return { kind: 'yjs', edited_by: body.editedBy || null }
}

function actorFromBrowser(body = {}) {
  if (!body.editedBy) {
    return { actor_kind: 'unknown', actor_id: null, actor_display_name: null, attribution_status: 'unknown' }
  }
  if (body.editedBy === 'fleet-source-editor' || String(body.editedBy).startsWith('device:')) {
    return { actor_kind: 'unknown', actor_id: null, actor_display_name: body.editedBy, attribution_status: 'unknown' }
  }
  return { actor_kind: 'human', actor_id: body.editedBy, actor_display_name: body.editedBy, attribution_status: 'direct' }
}

function actorFromOverleafCommit(commit = {}) {
  const author = commit.author || {}
  const email = author.email || ''
  const name = author.name || ''
  const anonymous = /anonymous/i.test(name) || /anonymous@overleaf\.com/i.test(email)
  if (anonymous) {
    return { actor_kind: 'anonymous', actor_id: null, actor_display_name: name || 'Anonymous', attribution_status: 'direct' }
  }
  const mapped = commit.actor || null
  return {
    actor_kind: mapped?.kind || 'human',
    actor_id: mapped?.id || (email ? `git:${email}` : null),
    actor_display_name: mapped?.display_name || name || email || null,
    attribution_status: 'direct',
  }
}

function normalizeActionFiles(files = []) {
  return files
    .filter(file => file?.path || file?.file_path)
    .map(file => ({
      path: file.path || file.file_path,
      absolute_path: file.absolute_path || null,
      before_hash: file.before_hash || null,
      after_hash: file.after_hash || null,
      patch: file.patch || file.diff || null,
      content_delta: file.content_delta || null,
    }))
}

function actionNeedles(actionFile) {
  if (actionFile.content_delta) return [String(actionFile.content_delta)]
  const patch = String(actionFile.patch || '')
  const added = []
  const removed = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  return [...added, ...removed].filter(line => line.trim() !== '')
}

function hunkSupportsAction(hunk, actionFile) {
  const haystack = [hunk.patch, hunk.after_text, hunk.before_text].filter(Boolean).join('\n')
  const needles = actionNeedles(actionFile)
  if (needles.length === 0) return false
  return needles.every(needle => haystack.includes(needle))
}

function hunkKey(file, index) {
  return `${file.path}:${index}`
}

function pendingStatesByTransaction(name) {
  const states = new Map()
  for (const record of readJsonl(name, 'attribution-pending')) {
    if (record.source_transaction_id) states.set(record.source_transaction_id, record)
  }
  return states
}

function emittedEvents(name) {
  return readJsonl(name, 'edit-events').filter(record => record.record_type === 'edit_event')
}

function usedAgentActionIds(events) {
  return new Set(events.map(event => event.attribution_basis?.agent_action_id).filter(Boolean))
}

function appendEditEvent(name, event) {
  appendJsonl(name, 'edit-events', {
    record_type: 'edit_event',
    record_id: event.event_id,
    ...event,
  })
}

function eventBaseForTransaction(txn) {
  return {
    project: txn.project,
    timestamp: txn.accepted_at,
    origin: txn.origin,
    source_identity: txn.source_identity,
    previous_source_revision: txn.previous_source_revision,
    after_source_revision: txn.after_source_revision,
    before_shadow_revision: txn.before_shadow_revision,
    after_shadow_revision: txn.after_shadow_revision || null,
    changed_pages: [],
  }
}

function appendDirectEvents(name, txn, body = {}) {
  if (txn.origin === 'overleaf' && Array.isArray(body.overleafCommits) && body.overleafCommits.length > 0) {
    for (const commit of body.overleafCommits) {
      const actor = actorFromOverleafCommit(commit)
      const changedPaths = new Set([...(commit.changed_paths || []), ...(commit.deleted_paths || [])])
      const changed_files = txn.changed_files.filter(file => changedPaths.size === 0 || changedPaths.has(file.path))
      if (changed_files.length === 0) continue
      const event_id = stableId('edit', { source_transaction_id: txn.record_id, commit: commit.hash })
      appendEditEvent(name, {
        ...eventBaseForTransaction(txn),
        event_id,
        ...actor,
        attribution_basis: {
          rule: 'overleaf-git-author',
          source_transaction_id: txn.record_id,
          commit_hash: commit.hash,
          author: commit.author || null,
          committer: commit.committer || null,
        },
        changed_files,
        manual_residual: false,
        ambiguous: false,
      })
    }
    return
  }
  const actor = actorFromBrowser(body)
  const event_id = stableId('edit', { source_transaction_id: txn.record_id, origin: txn.origin, actor: actor.actor_id || actor.actor_display_name })
  appendEditEvent(name, {
    ...eventBaseForTransaction(txn),
    event_id,
    ...actor,
    attribution_basis: {
      rule: actor.attribution_status === 'direct' ? 'yjs-authenticated-editor' : 'yjs-edited-by-fallback',
      source_transaction_id: txn.record_id,
      edited_by: body.editedBy || null,
    },
    changed_files: txn.changed_files,
    manual_residual: false,
    ambiguous: false,
  })
}

function latestEventsById(events) {
  const byId = new Map()
  for (const event of events) byId.set(event.event_id, event)
  return [...byId.values()]
}

export async function appendAgentAction(name, input = {}) {
  if (!await readProject(name)) throw new Error(`Project ${name} not found`)
  const files = normalizeActionFiles(input.files || [])
  if (files.length === 0) return null
  const record = {
    record_type: 'agent_action',
    project: name,
    record_id: input.record_id || stableId('agent-action', {
      project: name,
      agent_id: input.agent_id,
      tool_use_id: input.tool_use_id,
      files,
    }),
    daemon_key: input.daemon_key || null,
    machine_id: input.machine_id || null,
    env_name: input.env_name || null,
    agent_id: input.agent_id || null,
    agent_display_name: input.agent_display_name || input.agent_id || null,
    session_id: input.session_id || null,
    task_id: input.task_id || null,
    fleet_activity_event_id: input.fleet_activity_event_id || null,
    tool_use_id: input.tool_use_id || null,
    tool: input.tool || 'Edit',
    observed_at: input.observed_at || nowIso(),
    files,
  }
  appendJsonl(name, 'agent-actions', record)
  await reconcileProjectEditEvents(name)
  return record
}

export async function appendAgentActionFromActivity(activity, { daemonKey = null, machineId = null, envName = null } = {}) {
  const input = activity?.metadata?.input || activity?.input || {}
  const filePath = input.file_path || input.path
  if (!filePath || !getProjectsDir()) return null
  const candidates = []
  for (const project of await listProjects()) {
    const sourceRoot = `${projectDir(project.name)}/source/`
    const rel = relative(sourceRoot, filePath)
    if (!rel.startsWith('..') && rel !== '' && !rel.startsWith('/')) {
      candidates.push({ project: project.name, rel })
    }
  }
  if (candidates.length !== 1) return null
  const { project, rel } = candidates[0]
  return appendAgentAction(project, {
    daemon_key: daemonKey,
    machine_id: machineId,
    env_name: envName,
    agent_id: activity.from || activity.agent_id || null,
    agent_display_name: activity.from || activity.agent_id || null,
    fleet_activity_event_id: activity.id || null,
    tool_use_id: activity.metadata?.tool_use_id || activity.metadata?.id || input.id || null,
    tool: activity.metadata?.tool || activity.tool || 'Edit',
    observed_at: activity.timestamp || nowIso(),
    files: [{ path: rel, absolute_path: filePath, patch: input.diff || input.patch || null, content_delta: input.content_delta || null }],
  })
}

export async function recordAcceptedSourceTransaction(name, body = {}, acceptedSourceMutation = {}) {
  if (!acceptedSourceMutation?.sourceRevision) return null
  const lifecycle = await sourceLifecycleStore(name)
  const previousSnapshot = acceptedSourceMutation.previousRevision ? lifecycle.readRevision(acceptedSourceMutation.previousRevision) : null
  const afterSnapshot = lifecycle.readRevision(acceptedSourceMutation.sourceRevision)
  const changed_files = changedFilesFromSnapshots(previousSnapshot, afterSnapshot, acceptedSourceMutation.files || [], acceptedSourceMutation.deletedFiles || [])
  if (changed_files.length === 0) return null
  const origin = normalizeOrigin(body)
  const record_id = stableId('src-txn', {
    project: name,
    request_id: body.requestId || null,
    previous: acceptedSourceMutation.previousRevision || null,
    after: acceptedSourceMutation.sourceRevision,
    changed_files,
  })
  const txn = {
    record_type: 'source_transaction',
    record_id,
    project: name,
    request_id: body.requestId || record_id,
    origin,
    source_identity: sourceIdentityFor(body),
    accepted_at: body.acceptedAt || nowIso(),
    previous_source_revision: acceptedSourceMutation.previousRevision || null,
    after_source_revision: acceptedSourceMutation.sourceRevision,
    before_shadow_revision: body.beforeShadowRevision || null,
    after_shadow_revision: null,
    changed_files,
    deleted_files: acceptedSourceMutation.deletedFiles || [],
    ...(Array.isArray(body.overleafCommits) ? { overleaf_commits: body.overleafCommits } : {}),
  }
  appendJsonl(name, 'source-transactions', txn)
  if (origin === 'daemon') {
    appendJsonl(name, 'attribution-pending', {
      record_type: 'attribution_pending',
      record_id: stableId('pending', { source_transaction_id: record_id, state: 'pending' }),
      project: name,
      source_transaction_id: record_id,
      daemon_key: body.sourceDaemonKey || null,
      state: 'pending',
      pending_reason: 'awaiting-agent-actions',
      candidate_agent_action_ids: [],
    })
    await reconcileProjectEditEvents(name)
  } else {
    appendDirectEvents(name, txn, body)
  }
  return txn
}

export async function reconcileProjectEditEvents(name) {
  const txns = readJsonl(name, 'source-transactions').filter(record => record.record_type === 'source_transaction' && record.origin === 'daemon')
  const actions = readJsonl(name, 'agent-actions').filter(record => record.record_type === 'agent_action')
  const events = emittedEvents(name)
  const used = usedAgentActionIds(events)
  const pending = pendingStatesByTransaction(name)

  for (const txn of txns) {
    const state = pending.get(txn.record_id)
    if (state && !ACTIVE_PENDING_STATES.has(state.state)) continue
    if (events.some(event => event.attribution_basis?.source_transaction_id === txn.record_id && !event.ambiguous)) continue

    const hunkMatches = new Map()
    for (const file of txn.changed_files || []) {
      for (const [index, hunk] of (file.hunks || []).entries()) {
        const key = hunkKey(file, index)
        const matches = []
        for (const action of actions) {
          if (used.has(action.record_id)) continue
          if (txn.source_identity?.daemon_key && action.daemon_key && action.daemon_key !== txn.source_identity.daemon_key) continue
          const actionFile = (action.files || []).find(candidate => candidate.path === file.path)
          if (actionFile && hunkSupportsAction(hunk, actionFile)) matches.push(action)
        }
        hunkMatches.set(key, { file, hunk, matches })
      }
    }

    const uniqueActions = new Map()
    const ambiguousCandidates = new Set()
    const claimedHunks = new Set()
    for (const [key, match] of hunkMatches) {
      if (match.matches.length === 1) {
        const action = match.matches[0]
        const entry = uniqueActions.get(action.record_id) || { action, hunks: [] }
        entry.hunks.push({ key, file: match.file, hunk: match.hunk })
        uniqueActions.set(action.record_id, entry)
        claimedHunks.add(key)
      } else if (match.matches.length > 1) {
        for (const action of match.matches) ambiguousCandidates.add(action.record_id)
      }
    }

    if (uniqueActions.size === 0 && ambiguousCandidates.size === 0) {
      continue
    }

    for (const { action, hunks } of uniqueActions.values()) {
      const files = new Map()
      for (const item of hunks) {
        const entry = files.get(item.file.path) || { path: item.file.path, hunks: [] }
        entry.hunks.push(item.hunk)
        files.set(item.file.path, entry)
      }
      const event_id = stableId('edit', { source_transaction_id: txn.record_id, agent_action_id: action.record_id })
      appendEditEvent(name, {
        ...eventBaseForTransaction(txn),
        event_id,
        actor_kind: 'agent',
        actor_id: action.agent_id,
        actor_display_name: action.agent_display_name || action.agent_id,
        attribution_status: 'derived',
        attribution_basis: {
          rule: 'daemon-agent-patch-present',
          source_transaction_id: txn.record_id,
          agent_action_id: action.record_id,
          fleet_activity_event_id: action.fleet_activity_event_id || null,
          tool_use_id: action.tool_use_id || null,
          matched_files: [...files.keys()],
          matched_hunks: hunks.map(item => item.key),
        },
        changed_files: [...files.values()],
        manual_residual: false,
        ambiguous: false,
      })
      used.add(action.record_id)
    }

    const residualFiles = []
    for (const file of txn.changed_files || []) {
      const residualHunks = (file.hunks || []).filter((_, index) => !claimedHunks.has(hunkKey(file, index)))
      if (residualHunks.length) residualFiles.push({ path: file.path, hunks: residualHunks })
    }

    const emittedEventIds = [...uniqueActions.values()].map(({ action }) => stableId('edit', { source_transaction_id: txn.record_id, agent_action_id: action.record_id }))
    if (ambiguousCandidates.size > 0 && uniqueActions.size === 0) {
      const event_id = stableId('edit', { source_transaction_id: txn.record_id, ambiguous: [...ambiguousCandidates].sort() })
      appendEditEvent(name, {
        ...eventBaseForTransaction(txn),
        event_id,
        actor_kind: 'unknown',
        actor_id: null,
        actor_display_name: 'Ambiguous',
        attribution_status: 'unknown',
        attribution_basis: {
          rule: 'daemon-ambiguous-patch-decomposition',
          source_transaction_id: txn.record_id,
          candidate_agent_action_ids: [...ambiguousCandidates].sort(),
        },
        changed_files: txn.changed_files || [],
        manual_residual: false,
        ambiguous: true,
      })
      emittedEventIds.push(event_id)
    } else if (residualFiles.length > 0) {
      const event_id = stableId('edit', { source_transaction_id: txn.record_id, residual: residualFiles })
      appendEditEvent(name, {
        ...eventBaseForTransaction(txn),
        event_id,
        actor_kind: 'daemon',
        actor_id: txn.source_identity?.daemon_key || null,
        actor_display_name: txn.source_identity?.daemon_key || 'daemon/manual',
        attribution_status: 'inferred',
        attribution_basis: {
          rule: 'daemon-manual-residual',
          source_transaction_id: txn.record_id,
          consumed_agent_action_ids: [...uniqueActions.keys()],
        },
        changed_files: residualFiles,
        manual_residual: true,
        ambiguous: false,
      })
      emittedEventIds.push(event_id)
    }

    appendJsonl(name, 'attribution-pending', {
      record_type: 'attribution_pending',
      record_id: stableId('pending', { source_transaction_id: txn.record_id, emittedEventIds }),
      project: name,
      source_transaction_id: txn.record_id,
      daemon_key: txn.source_identity?.daemon_key || null,
      state: emittedEventIds.length > 0 ? (ambiguousCandidates.size > 0 && uniqueActions.size === 0 ? 'ambiguous' : 'finalized') : 'pending',
      pending_reason: emittedEventIds.length > 0 ? null : 'awaiting-agent-actions',
      candidate_agent_action_ids: [...ambiguousCandidates].sort(),
      consumed_agent_action_ids: [...uniqueActions.keys()],
      emitted_event_ids: emittedEventIds,
    })
  }
}

export async function finalizeEditEventsForSourceRevision(name, { sourceRevision, shadowRevision } = {}) {
  if (!sourceRevision || !shadowRevision) return []
  const current = latestEventsById(emittedEvents(name))
    .filter(event => event.after_source_revision === sourceRevision && !event.after_shadow_revision)
  if (current.length === 0) return []
  let pagesByHash = new Map()
  try {
    const changelog = await readShadowChangelog(name, { limit: null })
    pagesByHash = new Map((changelog.commits || []).map(commit => [commit.hash, commit.changedPages || []]))
  } catch {
    // Page mapping is enrichment; source attribution still finalizes without it.
  }
  const finalized = []
  for (const event of current) {
    const next = {
      ...event,
      before_shadow_revision: event.before_shadow_revision || null,
      after_shadow_revision: shadowRevision,
      changed_pages: pagesByHash.get(shadowRevision) || event.changed_pages || [],
      attribution_basis: { ...(event.attribution_basis || {}), shadow_finalized_by: 'recordBuildVersion' },
    }
    appendEditEvent(name, next)
    finalized.push(next)
  }
  return finalized
}

export async function readEditEvents(name, filters = {}) {
  if (!await readProject(name)) {
    const error = new Error('Project not found')
    error.code = 'PROJECT_NOT_FOUND'
    throw error
  }
  const since = filters.since ? Date.parse(filters.since) : null
  const until = filters.until ? Date.parse(filters.until) : null
  const limit = Number.isFinite(filters.limit) ? filters.limit : 200
  const includePending = filters.include_pending === true
  let events = latestEventsById(emittedEvents(name))
  events = events.filter(event => {
    const ts = Date.parse(event.timestamp)
    if (since && ts < since) return false
    if (until && ts > until) return false
    if (filters.origin && event.origin !== filters.origin) return false
    if (filters.actor && event.actor_id !== filters.actor && event.actor_display_name !== filters.actor) return false
    if (filters.actor_kind && event.actor_kind !== filters.actor_kind) return false
    if (filters.attribution_status && event.attribution_status !== filters.attribution_status) return false
    return true
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  if (Number.isFinite(limit)) events = events.slice(0, limit)
  const pending = readJsonl(name, 'attribution-pending')
  const latestPending = pendingStatesByTransaction(name)
  const actorsById = new Map()
  for (const event of events) {
    const key = event.actor_id || `${event.actor_kind}:${event.actor_display_name || 'unknown'}`
    actorsById.set(key, {
      actor_id: event.actor_id,
      display_name: event.actor_display_name,
      actor_kind: event.actor_kind,
    })
  }
  return {
    project: name,
    events,
    actors: [...actorsById.values()],
    origins: [...new Set(events.map(event => event.origin).filter(Boolean))].sort(),
    pending_count: [...latestPending.values()].filter(record => ACTIVE_PENDING_STATES.has(record.state)).length,
    ...(includePending ? { pending } : {}),
    generated_at: nowIso(),
  }
}

export const __test = {
  changedFilesFromSnapshots,
  hunkSupportsAction,
  stableId,
  readJsonl,
  editEventsDir,
  appendJsonl,
}
