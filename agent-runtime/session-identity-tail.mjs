export function tailSessionIdentityInput({
  sessionId,
  harnessKind,
  jsonlPath,
  ownerFleetId,
  contentIdentity = null,
} = {}) {
  const { fleet_id: _contentFleetId, ...identity } = contentIdentity || {}
  return {
    session_id: sessionId,
    harness_kind: harnessKind,
    jsonl_path: jsonlPath,
    ...identity,
    ...(harnessKind === 'codex' && ownerFleetId ? { fleet_id: ownerFleetId } : {}),
    classified: false,
  }
}
