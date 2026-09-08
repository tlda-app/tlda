// A mint row with no `process_state` says the daemon has no record of a
// process. It does not say no process is running. The mint and wake paths read
// the first as the second: `mintProcessAlive` and wake-core's `processAlive`
// both begin at `facts.processState?.tmux_session` and return false when it is
// absent, so the only discovery source for a live runtime was the very fact
// that was missing. A partial row therefore went straight to
// `launchMintProcess`, `uniqueSessionName` rotated the taken name to `-2`, and
// a second harness came up beside a live one -- with a second seat, and the
// original agent still running under a row that pointed at nothing.
//
// This module answers one question before any spawn: does a live runtime for
// THIS mint already exist? It answers only from bounded sources that are
// already authoritative -- the permission ledger's process bindings, the tmux
// session the launch recipe would have produced, and the harness runtime's own
// identity -- and it returns a decision rather than performing one. The daemon
// owns the writes; keeping the judgement here is what makes every branch
// testable without a tmux server.
//
// Three outcomes, and the two that are not `rebind` are the point:
//
//   rebind  exactly one candidate is live and its identity tuple is coherent
//           with the mint. Adopt it: write the missing facts, bind the seat
//           that already exists. No spawn, no seat request, no name allocation.
//   launch  every bounded source was examined and none of them holds a live
//           runtime. Absence is proven, so the ordinary launch is correct.
//   hold    the sources cannot settle it -- a probe that could not look, two
//           candidates that both fit, or one whose identity conflicts. Refuse:
//           do not bind, and do not spawn over what might be a live agent.
//
// `hold` is deliberately not a fallback to `launch`. Not looking is not
// evidence of absence, and spawning is the irreversible half of this decision.

export const RECOVERY_REBIND = 'rebind'
export const RECOVERY_LAUNCH = 'launch'
export const RECOVERY_HOLD = 'hold'
export const RECOVERY_SKIP = 'skip'

// Fields that identify the agent itself. A match on any one of these is a match
// on the identity, not on a coincidence of arrangement.
export const STRONG_IDENTITY_FIELDS = ['fleetId', 'mintId', 'sessionId']

// Fields that describe how the agent was arranged. Each of these is shared by
// every agent launched the same way, so no one of them identifies anybody --
// two mints of the same name in the same cwd in the same minute are exactly the
// case this exists to refuse. They authorize adoption only all together, and
// only when nothing in the strong set contradicts them.
export const TUPLE_IDENTITY_FIELDS = ['friendlyName', 'cwd', 'harness', 'model', 'envName', 'daemonKey']

function normalizeValue(field, value) {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  return field === 'harness' || field === 'model' ? text.toLowerCase() : text
}

// Compare only where both sides know the answer. A field one side has never
// recorded is unknown, not agreement -- counting it as a match is how a name
// alone starts authorizing an adoption.
export function compareIdentityTuple(expected = {}, observed = {}, fields = [...STRONG_IDENTITY_FIELDS, ...TUPLE_IDENTITY_FIELDS]) {
  const matched = []
  const conflicts = []
  const unknown = []
  for (const field of fields) {
    const want = normalizeValue(field, expected[field])
    const have = normalizeValue(field, observed[field])
    if (want === null || have === null) unknown.push(field)
    else if (want === have) matched.push(field)
    else conflicts.push({ field, expected: want, observed: have })
  }
  return { matched, conflicts, unknown }
}

// May this live runtime be adopted as this mint's own?
export function adoptionVerdict(expected = {}, observed = {}) {
  const comparison = compareIdentityTuple(expected, observed)
  // One contradiction is enough. A live runtime carrying a different FLEET_ID
  // is a different agent no matter how much of the rest lines up, and binding
  // the mint to it would take the running agent's identity away from it.
  if (comparison.conflicts.length) {
    return { ok: false, reason: 'identity-conflict', ...comparison }
  }
  const strong = comparison.matched.filter(field => STRONG_IDENTITY_FIELDS.includes(field))
  if (strong.length) return { ok: true, basis: `identity:${strong.join('+')}`, ...comparison }
  const missing = TUPLE_IDENTITY_FIELDS.filter(field => !comparison.matched.includes(field))
  if (missing.length) {
    return { ok: false, reason: 'insufficient-identity-evidence', missing, ...comparison }
  }
  return { ok: true, basis: 'coherent-tuple', ...comparison }
}

function candidateKey(candidate) {
  return String(candidate?.tmuxSession || '')
}

// The bounded search. `listSessions` is asked once and settles existence for
// every candidate; `probeSession` is asked only about candidates that exist.
export async function resolvePartialMintRuntime({
  facts,
  expectedIdentity,
  candidateSessions,
  listSessions,
  probeSession,
  observeRuntimeIdentity,
}) {
  if (!facts?.mintId) return { action: RECOVERY_SKIP, reason: 'no-mint-facts', examined: [] }
  if (facts.processState?.tmux_session) {
    return { action: RECOVERY_SKIP, reason: 'process-state-recorded', examined: [] }
  }

  const candidates = []
  const seen = new Set()
  for (const candidate of (await candidateSessions(facts)) || []) {
    const key = candidateKey(candidate)
    if (!key) continue
    // Same session named by two sources is one candidate with two reasons, not
    // two candidates. Collapsing them here is what keeps the ledger row and the
    // expected session name from reading as an ambiguity.
    if (seen.has(key)) {
      const existing = candidates.find(entry => candidateKey(entry) === key)
      if (existing) existing.sources = [...new Set([...existing.sources, candidate.source])]
      continue
    }
    seen.add(key)
    candidates.push({ ...candidate, sources: [candidate.source] })
  }
  if (!candidates.length) {
    return { action: RECOVERY_LAUNCH, reason: 'no-candidate-runtime', examined: [] }
  }

  const sessions = await listSessions()
  if (!sessions?.probed) {
    return { action: RECOVERY_HOLD, reason: 'tmux-unobserved', examined: candidates.map(candidateKey) }
  }
  const existing = new Set(sessions.names || [])

  const examined = []
  const live = []
  for (const candidate of candidates) {
    const session = candidateKey(candidate)
    if (!existing.has(session)) {
      examined.push({ session, sources: candidate.sources, state: 'absent' })
      continue
    }
    const probe = await probeSession(session)
    if (!probe?.probed) {
      return {
        action: RECOVERY_HOLD,
        reason: 'runtime-unprobed',
        session,
        examined: [...examined, { session, sources: candidate.sources, state: 'unprobed' }],
      }
    }
    if (!probe.runtime) {
      examined.push({ session, sources: candidate.sources, state: 'confirmed-dead' })
      continue
    }
    examined.push({ session, sources: candidate.sources, state: 'live' })
    live.push({ ...candidate, probe })
  }

  if (!live.length) {
    // Every source looked and none of them is running. Absence is proven, so
    // the ordinary path is correct: mint launches, and a wake whose candidate
    // session is confirmed dead goes on through the replacement policy it
    // already has. This branch adds no second way to start a process.
    const dead = examined.some(entry => entry.state === 'confirmed-dead')
    return { action: RECOVERY_LAUNCH, reason: dead ? 'runtime-confirmed-dead' : 'absence-proven', examined }
  }
  if (live.length > 1) {
    return {
      action: RECOVERY_HOLD,
      reason: 'ambiguous-candidates',
      sessions: live.map(candidateKey),
      examined,
    }
  }

  const [candidate] = live
  const observed = await observeRuntimeIdentity(candidate)
  const verdict = adoptionVerdict(expectedIdentity(facts), observed || {})
  if (!verdict.ok) {
    return {
      action: RECOVERY_HOLD,
      reason: verdict.reason,
      session: candidateKey(candidate),
      observed,
      verdict,
      examined,
    }
  }
  return {
    action: RECOVERY_REBIND,
    reason: verdict.basis,
    session: candidateKey(candidate),
    candidate,
    observed,
    verdict,
    examined,
  }
}
