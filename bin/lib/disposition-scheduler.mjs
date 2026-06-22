// Pure countdown scheduler for the disposition introspection bot.
//
// The whole bot is: turn ends → wait ~30s → if Skip didn't speak to that agent,
// poke it. This module is that logic with NO I/O, so it's unit-testable with a
// fake timer. The bot (bin/disposition-bot.mjs) wires it to the fleet WS:
// turn_ended → onTurnEnd, Skip-message-to-agent → onSkipMessage, manual command
// → kick. `sendPoke(agentId)` is the only side effect, injected by the caller.
//
// Design notes:
//  - SKIP-ABSENCE GATE (the primary trigger): the poke only fires when Skip is
//    AWAY. That's his standing rule — "when I'm in the room you shut the fuck
//    up; when I walk out you manage them." If he's active in the fleet at all he
//    is in the room, so presence is GLOBAL (not per-agent): when he's present,
//    every agent's expiring countdown is suppressed. The bot supplies presence
//    via the injected isSkipPresent() predicate; the scheduler checks it at FIRE
//    time (after the wait), so Skip arriving mid-countdown still silences it.
//  - The countdown is the "wait a beat" — don't poke the instant a turn ends.
//  - A new turn_ended for an agent supersedes its prior countdown (restart),
//    so a fast double-turn pokes once, at the end.
//  - Per-agent scoped timers: each agent has at most one pending timer. Skip
//    messaging agent X also cancels X's countdown immediately (he's in the room
//    with X); the global presence gate then covers everyone else.
//  - A MANUAL KICK bypasses the presence gate — it's Skip's explicit command.
//  - enabled=false stands the bot down entirely: no new countdowns start, and
//    onTurnEnd/kick become no-ops. Existing timers are cleared on disable.
//  - Timers are injected (setTimer/clearTimer) so tests drive a fake clock; the
//    bot passes the real setTimeout/clearTimeout. isSkipPresent is injected for
//    the same reason — tests stub presence directly.

export class DispositionScheduler {
  constructor({
    countdownMs = 30_000,
    enabled = true,
    sendPoke,
    isSkipPresent = () => false,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = () => {},
  } = {}) {
    if (typeof sendPoke !== 'function') throw new Error('sendPoke is required')
    this.countdownMs = countdownMs
    this.enabled = enabled
    this._sendPoke = sendPoke
    this._isSkipPresent = isSkipPresent
    this._setTimer = setTimer
    this._clearTimer = clearTimer
    this._log = log
    this._pending = new Map() // agentId → timer handle
  }

  /** An agent's turn ended → (re)start its introspection countdown. */
  onTurnEnd(agentId) {
    if (!this.enabled || !agentId) return
    this._clearPending(agentId) // a new turn supersedes the old countdown
    const handle = this._setTimer(() => {
      this._pending.delete(agentId)
      // Skip-absence gate, checked at fire time: if he's active in the fleet,
      // he's in the room — stay silent, he'll self-direct any agent that needs it.
      if (this._isSkipPresent()) { this._log('suppress-skip-present', agentId); return }
      this._fire(agentId, 'countdown-expired')
    }, this.countdownMs)
    this._pending.set(agentId, handle)
    this._log('countdown-start', agentId)
  }

  /** Skip messaged this agent → he's in the room with them; cancel their poke. */
  onSkipMessage(agentId) {
    if (!agentId) return
    if (this._clearPending(agentId)) this._log('cancel-skip-live', agentId)
  }

  /** Manual kick — poke this agent right now, regardless of any countdown. */
  kick(agentId) {
    if (!this.enabled || !agentId) return false
    this._clearPending(agentId)
    this._fire(agentId, 'manual-kick')
    return true
  }

  setCountdownMs(ms) {
    if (Number.isFinite(ms) && ms > 0) this.countdownMs = ms
  }

  /** Toggle the bot live. Disabling clears all pending countdowns. */
  setEnabled(on) {
    this.enabled = !!on
    if (!this.enabled) {
      for (const agentId of [...this._pending.keys()]) this._clearPending(agentId)
    }
  }

  /** Test/introspection helper. */
  pendingAgents() {
    return [...this._pending.keys()]
  }

  _fire(agentId, reason) {
    try { this._sendPoke(agentId) } catch (e) { this._log('poke-error', agentId, e.message) }
    this._log('poked', agentId, reason)
  }

  _clearPending(agentId) {
    const handle = this._pending.get(agentId)
    if (handle === undefined) return false
    this._clearTimer(handle)
    this._pending.delete(agentId)
    return true
  }
}
