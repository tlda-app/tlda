import path from 'path'

const UUID_SCAN_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

export function ledgerSessionId(input = {}) {
  if (!input?.session_id) return null
  if (input.harness_kind === 'codex') {
    return UUID_SCAN_RE.exec(input.session_id)?.[1]
      || UUID_SCAN_RE.exec(path.basename(input.jsonl_path || ''))?.[1]
      || input.session_id
  }
  return input.session_id
}

export function tailLedgerSessionInput({
  sessionId,
  harnessKind,
  jsonlPath,
  ownerFleetId,
  contentIdentity = null,
} = {}) {
  const { fleet_id: _contentFleetId, ...identity } = contentIdentity || {}
  return {
    session_id: ledgerSessionId({ session_id: sessionId, harness_kind: harnessKind, jsonl_path: jsonlPath }),
    harness_kind: harnessKind,
    jsonl_path: jsonlPath,
    ...identity,
    ...(harnessKind === 'codex' && ownerFleetId ? { fleet_id: ownerFleetId } : {}),
    classified: false,
  }
}
