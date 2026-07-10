import fs from 'fs'
import path from 'path'
import { findSessionsByFleetId } from './session-identity-store.mjs'
import { scanCodexRolloutIdentity } from '../agent-launch/resume.mjs'

export const CODEX_FLEET_ID_MIGRATION_COMMAND = 'node scripts/migrate-codex-fleet-ids.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_SCAN_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

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
    message: detail.message || null,
    retry_after_ms: detail.retry_after_ms || 1000,
    detail: {
      advanced_once: !!detail.advanced_once,
      active_tail: !!detail.active_tail,
      reason,
      ...(detail.extra || {}),
    },
  }
}

function cachedIdentityMiss(agent, options = {}) {
  const name = agent?.friendly_name || agent?.name || agent?.id || 'unknown'
  const fleetId = agent?.id || 'unknown'
  return typedMiss(agent, 'missing-resume-handle', 'no-record', {
    retry_after_ms: options.retryAfterMs,
    message: `can't find a cached identity for ${name} (${fleetId}) - historically we've mis-recorded this. To scan for it, run: \`${CODEX_FLEET_ID_MIGRATION_COMMAND}\` (daemon stopped).`,
    extra: {
      escape_hatch: CODEX_FLEET_ID_MIGRATION_COMMAND,
      daemon_must_be_stopped: true,
    },
  })
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

function newestRecords(records) {
  return [...records].sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''))
}

export function resolveCodexResumeHandleFromIdentity(agent, options = {}) {
  if (!agent?.id) return typedMiss(agent, 'missing-resume-handle', 'no-agent-id', { retry_after_ms: options.retryAfterMs })
  const records = newestRecords(findSessionsByFleetId(agent.id, 'codex', identityStoreLookupOptions(options)))
  for (const rec of records) {
    if (!rec?.session_id) continue
    if (!isBareCodexResumeId(rec.session_id)) {
      if (rec.jsonl_path && fs.existsSync(rec.jsonl_path)) {
        const { sessionMeta } = scanCodexRolloutIdentity(rec.jsonl_path)
        const repairedId = codexResumeIdFromPath(rec.jsonl_path, sessionMeta)
        if (repairedId) {
          return success(agent, { ...rec, session_id: repairedId }, options.source || 'identity-store-repaired')
        }
      }
      return typedMiss(agent, 'missing-resume-handle', 'invalid-uuid', {
        retry_after_ms: options.retryAfterMs,
        extra: { session_id: rec.session_id },
      })
    }
    if (rec.jsonl_path && !fs.existsSync(rec.jsonl_path)) continue
    return success(agent, rec, options.source || 'identity-store')
  }
  return cachedIdentityMiss(agent, options)
}

export async function resolveCodexResumeHandle(agent, options = {}) {
  const indexed = resolveCodexResumeHandleFromIdentity(agent, options)
  if (indexed.ok) return indexed
  return indexed
}
