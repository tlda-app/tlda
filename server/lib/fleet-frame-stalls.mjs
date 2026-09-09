// Records that a fleet WS frame ARRIVED, so an unanswered one can be told apart
// from one that never reached the router.
//
// Nothing recorded arrival before this, and that is the exact gap in the
// first-load identity hang: the client sends `agents-page`, waits 45s, times out,
// and there is no server-side record either way. The two remaining shapes are
// indistinguishable without it —
//
//   recorded, never answered -> it arrived and the handler stalled
//   never recorded           -> it never reached the router, and the question is
//                               connection acceptance
//
// Measured 2026-09-03 before building this, because the cheap check is to ask what
// already measures it: across the page-hang window (06:54-07:29Z) the lag profiler
// dumped every ~70s with no gaps, all 252-428ms and idle-dominated. The server took
// the frames, was not busy, and did not answer. The loop is excluded, so this is
// what is left to ask, and nothing else asks it.
//
// The hot path does a Map set and a Map delete, for id-bearing frames only. No
// string formatting, no I/O, and the socket itself is never retained -- a frame in
// flight must not be able to keep a closed socket alive. A healthy server writes
// nothing at all: only frames still unanswered at the sweep produce a line.
//
// stdout is deliberately not the sink. `fly logs` holds about 57 seconds, which
// cannot answer a question asked after the incident -- which is how this defect is
// always encountered.

const DEFAULT_STALL_MS = 30_000

export function resolveStallMs(env = process.env) {
  const configured = Number(env.TLDA_FLEET_FRAME_STALL_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALL_MS
}

export function createFleetFrameStallTracker({ stallMs, append, now = () => Date.now() }) {
  // Bounded by CONCURRENCY, not by traffic: an entry leaves as soon as its handler
  // settles, so this holds only frames actually in flight.
  const inFlight = new Map()
  let seq = 0

  return {
    // Returns a key the caller settles in a `finally`. Copies primitives rather
    // than the socket, and rather than a formatted peer string, so a healthy
    // request pays nothing it will not use.
    note(ws, msg) {
      const key = ++seq
      inFlight.set(key, {
        requestId: msg.id,
        type: msg.type || null,
        at: now(),
        agentId: ws?._tldaAgentId || null,
        humanId: ws?._tldaHumanId || null,
        connId: ws?._connId || null,
      })
      return key
    },

    settle(key) {
      if (key !== null && key !== undefined) inFlight.delete(key)
    },

    sweep() {
      if (!inFlight.size) return 0
      const at = now()
      let lines = ''
      let reported = 0
      for (const [key, frame] of inFlight) {
        if (at - frame.at < stallMs) continue
        // Dropped as it is reported, so one stalled frame produces one line rather
        // than a line every sweep for as long as it stays stuck.
        inFlight.delete(key)
        reported += 1
        lines += `${new Date(at).toISOString()} unanswered after ${at - frame.at}ms `
          + `type=${frame.type} request=${frame.requestId} `
          + `agent=${frame.agentId || '-'} human=${frame.humanId || '-'} conn=${frame.connId || '-'}\n`
      }
      if (lines) append(lines)
      return reported
    },

    // Test/diagnostic read only.
    size() { return inFlight.size },
  }
}
