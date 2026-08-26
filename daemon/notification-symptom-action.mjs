// What this machine does about what the server saw.
//
// THE MAPPING LIVES ON THE DAEMON SIDE, AND THAT IS THE POINT. The server
// reports a fact about its own socket and selects no remedy — "this is your
// machine, look into it" — so this table can change here without the server
// knowing anything about it. See docs/notifications-and-liveness.md
// §"The back-off: the server reports a symptom, the daemon decides the remedy".
//
// Notification symptoms can select one lifecycle action from §"Liveness: what
// the daemon is for":
//
//   ensure-process   no process -> make one; process there -> no-op
//
// It is idempotent, which is what lets the server keep no memory of what it has
// already reported and simply report again when it sees the symptom again.
//
// Silence authorizes a message to the existing session, not a lifecycle action.
// Automatically turning that observation into a restart destroys the live tmux
// session and the turn in it. A refusal is a healthy MCP saying no, so it needs
// no action at all.
export const NOTIFICATION_SYMPTOM_ACTION = Object.freeze({
  'no-channel': 'ensure-process',
  'channel-closed': 'ensure-process',
  'channel-silent': 'suggest-restart',
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

export async function performNotificationSymptomAction({ symptom, ensureProcess, suggestRestart }) {
  const action = actionForSymptom(symptom)
  if (!action) return null
  if (action === 'ensure-process') {
    await ensureProcess()
    return 'wake'
  }
  if (action === 'suggest-restart') {
    await suggestRestart()
    return 'suggest-restart'
  }
  return null
}
