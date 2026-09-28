// P1: daemon-side never-joined verdicts. A mint row still unjoined past the
// launch-latency grace gets a verdict grounded in process evidence — never a
// clock verdict. The process reading comes from the liveness state machine
// (`stateFor`), never from a probe of this module's own: process absence gets
// exactly one decider, and a sweep that probed independently would be a
// second liveness authority disagreeing with the first eventually.
//
// `stateFor` rather than `verdictFor`, deliberately: the display verdict
// conflates waking with dead (a waking binding shows hibernating), while the
// sweep needs the process reading. Awake, dying, and waking all mean a
// process was sighted; only hibernating means the machine reads no process.
// A null reading (no binding, never observed) is not evidence of anything.
//
// Machine hibernating -> `absent` (retires the shell, retracts the task,
// tells the owner). Machine awake or dying with no attestable session ->
// `leaked-alive` (informational: a live process is never a failure).
// Waking or null with no attestable session -> nothing: one sighting is
// suspicion, and not looking is not evidence.
//
// Before any alive-verdict, the sweep attempts late identity resolution: a
// transcript written after deferred discovery gave up must still join. The
// discovery deadline stops the mint commit path waiting; it must never
// convert "not yet" into "never", and the sweep running forever is what
// keeps that promise. An attested record joins through the normal
// recordSession path and no verdict emits. A row with no fleet id cannot
// join and has no binding for the machine to read; an attested record there
// emits leaked-alive on mint linkage (a lost seat response may still have
// left a shell row the server can find), and nothing otherwise.
//
// Launch-latency grace: a process exists within seconds of accepted launch
// or never; 10 minutes is paranoia (accepted P1 design, restated gate). This
// gates EXAMINATION, never the verdict — there is no clock on live processes.
export const NEVER_JOINED_GRACE_MS = 10 * 60 * 1000

export function neverJoinedCutoffIso(nowMs = Date.now(), graceMs = NEVER_JOINED_GRACE_MS) {
  return new Date(nowMs - graceMs).toISOString()
}

// Examine one unjoined mint row. Returns the emitted verdict, 'joined' when
// late resolution completed the join, or null.
// `livenessState(agentId)` answers the liveness machine's stateFor;
// `resolveIdentity(facts)` makes one identity-resolution attempt (the sweep
// is the retry loop, so no polling here) and answers { sessionId, jsonlPath }
// or null; `adoptIdentity({ session_id, session_path })` records an attested
// identity; `emit(msg)` sends it daemon→server; `emitted` holds
// `${mint_id}:${verdict}` pairs already sent this daemon lifetime (the server
// admission is durably idempotent, so this set only spares re-sends, never
// correctness). Adopt errors propagate: the sweep wrapper reports per-row
// failures, and the row is re-examined on the next sweep.
export async function examineNeverJoinedRow({ facts, livenessState, resolveIdentity, adoptIdentity, emit, emitted, daemonKey, source = 'daemon-never-joined-sweep' }) {
  if (!facts || facts.joinedAt) return null
  const session = facts.processState && typeof facts.processState === 'object' ? facts.processState.tmux_session : null
  if (!session) return null
  const checkedAt = new Date().toISOString()
  const agentId = facts.fleetId || null
  let state = null
  if (agentId && typeof livenessState === 'function') {
    try {
      state = await livenessState(agentId)
    } catch {
      state = null
    }
  }
  if (state === 'hibernating') {
    return emitVerdict({ facts, agentId, session, daemonKey, source, checkedAt, emit, emitted,
      verdict: 'absent',
      observed: { session, machine_state: state, runtime: false, probed: true, checked_at: checkedAt },
      reason: 'liveness machine reads hibernating for unjoined mint',
    })
  }
  let live = null
  if (typeof resolveIdentity === 'function') {
    try {
      live = await resolveIdentity(facts)
    } catch {
      live = null
    }
  }
  if (live?.sessionId) {
    if (typeof adoptIdentity === 'function') {
      await adoptIdentity({ session_id: live.sessionId, session_path: live.jsonlPath || null })
    }
    if (!agentId) {
      return emitVerdict({ facts, agentId, session, daemonKey, source, checkedAt, emit, emitted,
        verdict: 'leaked-alive',
        observed: { session, machine_state: 'unobserved', runtime: true, probed: true, checked_at: checkedAt },
        reason: 'worker attested for seatless unjoined mint',
      })
    }
    return 'joined'
  }
  if (state === 'awake' || state === 'dying') {
    return emitVerdict({ facts, agentId, session, daemonKey, source, checkedAt, emit, emitted,
      verdict: 'leaked-alive',
      observed: { session, machine_state: state, runtime: true, probed: true, checked_at: checkedAt },
      reason: `liveness machine reads ${state} for unjoined mint`,
    })
  }
  return null
}

async function emitVerdict({ facts, agentId, session, daemonKey, source, checkedAt, emit, emitted, verdict, observed, reason }) {
  const key = `${facts.mintId}:${verdict}`
  if (emitted?.has(key)) return null
  const msg = {
    type: 'never-joined',
    verdict,
    agent_id: agentId,
    mint_id: facts.mintId,
    daemon_key: daemonKey,
    observed,
    reason,
    source,
    ts: checkedAt,
  }
  await emit(msg)
  emitted?.add(key)
  return verdict
}
