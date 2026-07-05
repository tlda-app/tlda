import fs from 'fs'
import os from 'os'
import path from 'path'
import { findSessionsByFleetId } from './session-identity-store.mjs'
import { acquireSingletonLock, sessionReaderLockPath } from './singleton-lock.mjs'
import { scanCodexRolloutIdentity } from './spawn/resume.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_SCAN_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

function codexSessionsBase(base) {
  return base || path.join(os.homedir(), '.codex', 'sessions')
}

function identityStoreLookupOptions(options = {}) {
  return {
    configDir: options.identityConfigDir || options.configDir,
    filePath: options.identityFilePath || options.filePath,
  }
}

export function isBareCodexResumeId(value) {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function codexResumeIdFromPath(filePath, sessionMeta = {}) {
  const id = sessionMeta?.id || UUID_SCAN_RE.exec(path.basename(filePath || ''))?.[1] || null
  return isBareCodexResumeId(id) ? id : null
}

function typedMiss(agent, code, reason, detail = {}) {
  return {
    ok: false,
    code,
    fleetId: agent?.id || null,
    retry_after_ms: detail.retry_after_ms || 1000,
    detail: {
      advanced_once: !!detail.advanced_once,
      active_tail: !!detail.active_tail,
      reason,
      ...(detail.extra || {}),
    },
  }
}

function success(agent, rec, source) {
  return {
    ok: true,
    kind: 'codex',
    fleetId: agent.id,
    resumeId: rec.session_id,
    jsonlPath: rec.jsonl_path || null,
    cwd: rec.cwd || null,
    source,
  }
}

function readerAlreadyRunning(agent, lockPath, holder = {}) {
  return typedMiss(agent, 'reader-already-running', 'lock-held', {
    retry_after_ms: 1000,
    extra: { lock: lockPath, holder },
  })
}

function newestRecords(records) {
  return [...records].sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''))
}

export function resolveCodexResumeHandleFromIdentity(agent, options = {}) {
  if (!agent?.id) return typedMiss(agent, 'missing-resume-handle', 'no-agent-id', { retry_after_ms: options.retryAfterMs })
  const records = newestRecords(findSessionsByFleetId(agent.id, 'codex', identityStoreLookupOptions(options)))
  for (const rec of records) {
    if (!rec?.session_id) continue
    if (!isBareCodexResumeId(rec.session_id)) {
      return typedMiss(agent, 'missing-resume-handle', 'invalid-uuid', {
        retry_after_ms: options.retryAfterMs,
        extra: { session_id: rec.session_id },
      })
    }
    if (rec.jsonl_path && !fs.existsSync(rec.jsonl_path)) continue
    return success(agent, rec, options.source || 'identity-store')
  }
  return typedMiss(agent, 'missing-resume-handle', 'no-record', { retry_after_ms: options.retryAfterMs })
}

function walkFiles(root, accept) {
  const out = []
  function visit(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (accept(full, entry.name)) out.push(full)
    }
  }
  visit(root)
  return out
}

export function directColdReadCodexResumeHandle(agent, options = {}) {
  if (!agent?.id) return typedMiss(agent, 'missing-resume-handle', 'no-agent-id', { retry_after_ms: options.retryAfterMs })
  let lock = null
  if (options.requireReaderLock !== false) {
    const configDir = options.identityConfigDir || options.configDir || path.join(os.homedir(), '.config', 'tlda')
    const lockPath = options.readerLockPath || sessionReaderLockPath({ configDir })
    lock = acquireSingletonLock({
      lockPath,
      installPath: options.installPath || process.cwd(),
      origin: options.lockOrigin || null,
    })
    if (!lock.ok) return readerAlreadyRunning(agent, lockPath, lock.holder)
  }
  try {
    const base = codexSessionsBase(options.sessionsBase)
    if (!fs.existsSync(base)) return typedMiss(agent, 'missing-resume-handle', 'no-record', { retry_after_ms: options.retryAfterMs })
    const candidates = []
    for (const fpath of walkFiles(base, (_full, name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
      const { ownId, sessionMeta } = scanCodexRolloutIdentity(fpath)
      if (ownId !== agent.id) continue
      const resumeId = codexResumeIdFromPath(fpath, sessionMeta)
      if (!resumeId) {
        return typedMiss(agent, 'missing-resume-handle', 'invalid-uuid', {
          retry_after_ms: options.retryAfterMs,
          extra: { jsonlPath: fpath },
        })
      }
      let mtime = 0
      try {
        mtime = fs.statSync(fpath).mtimeMs
      } catch {
        continue
      }
      candidates.push({
        session_id: resumeId,
        jsonl_path: fpath,
        cwd: sessionMeta.cwd || null,
        updated_at: new Date(mtime).toISOString(),
        mtime,
      })
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    const best = candidates[0]
    return best ? success(agent, best, 'direct-cold-read') : typedMiss(agent, 'missing-resume-handle', 'no-record', { retry_after_ms: options.retryAfterMs })
  } finally {
    if (lock?.fd != null) {
      try { fs.closeSync(lock.fd) } catch { /* best effort */ }
    }
  }
}

export async function resolveCodexResumeHandle(agent, options = {}) {
  const indexed = resolveCodexResumeHandleFromIdentity(agent, options)
  if (indexed.ok) return indexed
  if (options.mode === 'direct' || options.readerCommand === 'cold-read') {
    return directColdReadCodexResumeHandle(agent, options)
  }
  if (options.advanceOnceOnMiss && typeof options.advanceOnce === 'function') {
    const advanced = await options.advanceOnce(agent, indexed)
    if (advanced?.ok === false) return advanced
    const afterAdvance = resolveCodexResumeHandleFromIdentity(agent, {
      ...options,
      source: 'live-reader',
    })
    if (afterAdvance.ok) return afterAdvance
    return {
      ...afterAdvance,
      code: 'identity-ingestion-pending',
      detail: {
        ...afterAdvance.detail,
        advanced_once: true,
        active_tail: !!advanced?.active_tail,
      },
    }
  }
  return indexed
}
