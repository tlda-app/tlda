import fs from 'fs'
import { createPermissionLedger } from '../agent-launch/permission-ledger.mjs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isBareCodexResumeId(value) {
  return typeof value === 'string' && UUID_RE.test(value)
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
    message: `can't find a daemon-ledger resume identity for ${name} (${fleetId}); this is a ledger write/key bug, not a lost rollout`,
    extra: {
      expected_source: 'daemon permission ledger session_id',
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

function openLedger(options = {}) {
  if (options.permissionLedger) return { ledger: options.permissionLedger, close: async () => {} }
  const ledger = createPermissionLedger(options.permissionLedgerPath)
  return { ledger, close: () => ledger.close() }
}

export async function resolveCodexResumeHandleFromLedger(agent, options = {}) {
  if (!agent?.id) return typedMiss(agent, 'missing-resume-handle', 'no-agent-id', { retry_after_ms: options.retryAfterMs })
  const { ledger, close } = openLedger(options)
  try {
    const rec = ledger.get(agent.id)
    if (!rec?.sessionId) return cachedIdentityMiss(agent, options)
    if (rec.sessionKind && rec.sessionKind !== 'codex') {
      return typedMiss(agent, 'missing-resume-handle', 'invalid-uuid', {
        retry_after_ms: options.retryAfterMs,
        extra: { session_kind: rec.sessionKind },
      })
    }
    if (!isBareCodexResumeId(rec.sessionId)) {
      return typedMiss(agent, 'missing-resume-handle', 'invalid-uuid', {
        retry_after_ms: options.retryAfterMs,
        extra: { session_id: rec.sessionId },
      })
    }
    if (rec.sessionPath && !fs.existsSync(rec.sessionPath)) {
      return typedMiss(agent, 'missing-resume-handle', 'missing-session-path', {
        retry_after_ms: options.retryAfterMs,
        extra: { session_path: rec.sessionPath },
      })
    }
    return success(agent, {
      session_id: rec.sessionId,
      jsonl_path: rec.sessionPath,
      cwd: rec.cwd,
    }, options.source || 'daemon-ledger')
  } finally {
    await close()
  }
}

export async function resolveCodexResumeHandle(agent, options = {}) {
  return resolveCodexResumeHandleFromLedger(agent, options)
}
