// P1: daemon-side never-joined verdicts. A mint row still unjoined past the
// launch-latency grace gets a process-grounded verdict — never a clock
// verdict. Process alive -> `leaked-alive` (informational: a live process is
// never a failure). Process confirmed gone -> `absent` (positive observation
// by the party that can see it). Probe inconclusive, or no session recorded
// at all (pre-F2 rows), -> no verdict: not looking is not evidence, and an
// absent record is not an absent process.

import { sessionConfirmedDead } from '../agent-launch/tmux.mjs'

// Launch-latency grace: a process exists within seconds of accepted launch
// or never; 10 minutes is paranoia (accepted P1 design, restated gate). This
// gates EXAMINATION, never the verdict — there is no clock on live processes.
export const NEVER_JOINED_GRACE_MS = 10 * 60 * 1000

export function neverJoinedCutoffIso(nowMs = Date.now(), graceMs = NEVER_JOINED_GRACE_MS) {
  return new Date(nowMs - graceMs).toISOString()
}

// Examine one unjoined mint row. Returns the emitted verdict or null.
// `probeSession(session)` answers sessionRuntimeState; `emit(msg)` sends it
// daemon→server; `emitted` holds `${mint_id}:${verdict}` pairs already sent
// this daemon lifetime (the server admission is durably idempotent, so this
// set only spares re-sends, never correctness).
export async function examineNeverJoinedRow({ facts, probeSession, emit, emitted, daemonKey, source = 'daemon-never-joined-sweep' }) {
  if (!facts || facts.joinedAt) return null
  const session = facts.processState && typeof facts.processState === 'object' ? facts.processState.tmux_session : null
  if (!session) return null
  const checkedAt = new Date().toISOString()
  let probe
  try {
    probe = await probeSession(session)
  } catch {
    return null
  }
  const runtime = !!probe?.runtime
  const verdict = runtime ? 'leaked-alive' : (sessionConfirmedDead(probe) ? 'absent' : null)
  if (!verdict) return null
  const key = `${facts.mintId}:${verdict}`
  if (emitted?.has(key)) return null
  const msg = {
    type: 'never-joined',
    verdict,
    agent_id: facts.fleetId || null,
    mint_id: facts.mintId,
    daemon_key: daemonKey,
    observed: { session, runtime, probed: !!probe?.probed, checked_at: checkedAt },
    reason: verdict === 'absent' ? 'process confirmed gone for unjoined mint' : 'process alive for unjoined mint',
    source,
    ts: checkedAt,
  }
  await emit(msg)
  emitted?.add(key)
  return verdict
}
