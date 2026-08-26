// What this machine does about what the server saw.
//
// THE MAPPING LIVES ON THE DAEMON SIDE, AND THAT IS THE POINT. The server
// reports a fact about its own socket and selects no remedy — "this is your
// machine, look into it" — so this table can change here without the server
// knowing anything about it. See docs/notifications-and-liveness.md
// §"The back-off: the server reports a symptom, the daemon decides the remedy".
//
// There are exactly two actions, because §"Liveness: what the daemon is for"
// gives the daemon exactly two jobs:
//
//   ensure-process   no process -> make one; process there -> no-op
//   restart          a process that is not answering -> off and on again
//
// Both are idempotent, which is what lets the server keep no memory of what it
// has already reported and simply report again when it sees the symptom again.
//
// `channel-refused` maps to NOTHING, deliberately. A refusal is a healthy MCP
// saying no, so nothing on this machine is wrong. It is also the clearest reason
// the nack has to exist: without it that same case arrives as `channel-silent`,
// and this table would restart an agent that is working perfectly well.
export const NOTIFICATION_SYMPTOM_ACTION = Object.freeze({
  'no-channel': 'ensure-process',
  'channel-closed': 'ensure-process',
  'channel-silent': 'restart',
  'channel-refused': null,
})

/**
 * The action for a symptom, or null for "record it and do nothing".
 *
 * An unrecognised symptom returns null rather than a default. A newer server
 * sending a name this daemon has never heard of must not have it guessed into a
 * restart — the whole failure mode this subsystem has is doing something drastic
 * to a healthy agent on thin evidence.
 */
export function actionForSymptom(symptom) {
  // `hasOwn` rather than a plain lookup, and it is not defensive noise: a plain
  // lookup answers `NOTIFICATION_SYMPTOM_ACTION['constructor']` with a FUNCTION,
  // which `?? null` passes straight through as though it were an action. The
  // caller treats any truthy action that is not `ensure-process` as `restart`,
  // so a symptom named after a prototype key would have restarted a healthy
  // agent. Caught by the test below this file's sibling.
  if (typeof symptom !== 'string') return null
  if (!Object.hasOwn(NOTIFICATION_SYMPTOM_ACTION, symptom)) return null
  return NOTIFICATION_SYMPTOM_ACTION[symptom] ?? null
}

export async function performNotificationSymptomAction({ symptom, checkAlive, ensureProcess, restart }) {
  const action = actionForSymptom(symptom)
  if (!action) return null
  if (action === 'ensure-process') {
    await ensureProcess()
    return 'wake'
  }
  const alive = await checkAlive()
  if (!alive) {
    await ensureProcess()
    return 'wake'
  }
  await restart()
  return 'restart'
}
