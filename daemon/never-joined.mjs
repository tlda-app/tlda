// P1: daemon-side never-joined verdicts. A mint row still unjoined past the
// launch-latency grace gets a process-grounded verdict — never a clock
// verdict. Process alive -> `leaked-alive` (informational: a live process is
// never a failure). Session observed absent from the tmux list, or listed
// but with dead panes -> `absent` (a positive observation by the party that
// can see it). An unobserved list, an inconclusive probe, or a row with no
// recorded session at all (pre-F2 rows) -> no verdict: not looking is not
// evidence, and an absent record is not an absent process.
//
// The alive-test is the design's own "pane pid dead / session vanished"
// (air-settle §5: "process gone (pane pid dead / session vanished)"), read
// via sessionPaneAlive: any pane pid signalling OK is a live process,
// whatever it runs. An earlier revision used sessionRuntimeState —
// agent-CLI-or-node detection — which called a pane holding a live non-agent
// process dead; that was the deviation, caught by the harness on a sleep
// specimen 2026-09-27, and this is the restoration. Do not "tighten" it
// back: AWAKE=PROCESS, and runtime-semantics is the interpretation layer
// that rule forbids. Under `absent` the waiter is told its process is gone,
// so that verdict must never fire while a pane pid exists.
//
// Absence is read off `list-sessions`, never off a failed per-session probe:
// `list-panes -t <session>` fails identically for an absent session and an
// unreachable tmux, so only the list can confirm absence (tmux-target.mjs
// documents the trap). The recorded name is final (F2 writes it
// post-uniqueSessionName, spawnTmux never rotates silently), so a missing
// name is a missing process, not a renamed one.

// Launch-latency grace: a process exists within seconds of accepted launch
// or never; 10 minutes is paranoia (accepted P1 design, restated gate). This
// gates EXAMINATION, never the verdict — there is no clock on live processes.
export const NEVER_JOINED_GRACE_MS = 10 * 60 * 1000

export function neverJoinedCutoffIso(nowMs = Date.now(), graceMs = NEVER_JOINED_GRACE_MS) {
  return new Date(nowMs - graceMs).toISOString()
}

// Examine one unjoined mint row. Returns the emitted verdict or null.
// `listSessions()` answers listSessionNames ({probed, names});
// `probeSession(session)` answers sessionPaneAlive ({probed, alive, pids});
// `emit(msg)` sends it daemon→server; `emitted` holds `${mint_id}:${verdict}`
// pairs already sent this daemon lifetime (the server admission is durably
// idempotent, so this set only spares re-sends, never correctness).
export async function examineNeverJoinedRow({ facts, listSessions, probeSession, emit, emitted, daemonKey, source = 'daemon-never-joined-sweep' }) {
  if (!facts || facts.joinedAt) return null
  const session = facts.processState && typeof facts.processState === 'object' ? facts.processState.tmux_session : null
  if (!session) return null
  const checkedAt = new Date().toISOString()
  let list
  try {
    list = await listSessions()
  } catch {
    return null
  }
  if (!list || list.probed !== true || !Array.isArray(list.names)) return null
  let verdict = null
  let observed = null
  if (!list.names.includes(session)) {
    verdict = 'absent'
    observed = { session, session_listed: false, runtime: false, probed: true, checked_at: checkedAt }
  } else {
    let probe
    try {
      probe = await probeSession(session)
    } catch {
      return null
    }
    if (probe?.alive) {
      verdict = 'leaked-alive'
      observed = { session, session_listed: true, runtime: true, pane_pids: probe.pids || [], probed: !!probe?.probed, checked_at: checkedAt }
    } else if (probe?.probed) {
      verdict = 'absent'
      observed = { session, session_listed: true, runtime: false, pane_pids: probe.pids || [], probed: true, checked_at: checkedAt }
    } else {
      return null
    }
  }
  const key = `${facts.mintId}:${verdict}`
  if (emitted?.has(key)) return null
  const msg = {
    type: 'never-joined',
    verdict,
    agent_id: facts.fleetId || null,
    mint_id: facts.mintId,
    daemon_key: daemonKey,
    observed,
    reason: verdict === 'absent' ? 'process confirmed gone for unjoined mint' : 'process alive for unjoined mint',
    source,
    ts: checkedAt,
  }
  await emit(msg)
  emitted?.add(key)
  return verdict
}
