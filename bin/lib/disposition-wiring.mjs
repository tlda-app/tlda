// Pure wiring between fleet-events and the disposition scheduler.
//
// The bot (bin/disposition-bot.mjs) is the I/O shell: it owns the WS, the timers
// and sendChat. This module owns the decision STATE — Skip's presence, the
// per-agent cwd cache, and the per-turn trigger/work tracking — plus the
// dispatch from a fleet-event to the scheduler. No WS, no timers, no clock of
// its own: the scheduler and `now` are injected, so it's unit-testable with a
// fake clock alongside a real DispositionScheduler.
//
// Suppression conditions (any one keeps the poke from firing for a turn):
//   1. ABSENCE GATE (in the scheduler, checked at fire time): Skip is active in
//      the fleet → he's in the room → stay quiet. Presence = a chat from Skip
//      (UI or terminal, both from_id=ownerId) within presenceWindowMs.
//   2. POKE-LOOP GATE (here, decided at turn_ended): the turn was a response to
//      the bot's OWN poke. Don't re-poke a turn the bot itself caused; the
//      next real inbound from Skip or another agent overrides the bot trigger.
//   - A manual kick bypasses both (it's Skip's explicit command).
//
// "Did real work" = the turn emitted an activity event whose tool is something
// other than plain text and the comms tools (a chat reply is itself a tool
// call). Errs toward "work" on ambiguous tools.
const COMMENT_TOOLS = new Set([
  '_text', '_usage', '_prettyResult',
  'tlda/reply_note', 'tlda/report', 'tlda/notify', 'tlda/share',
  'tlda/task_done', 'task_done',
  'mcp__tlda__task_done',
])
const CHAT_TOOLS = new Set(['chat', 'tlda/chat', 'mcp__tlda__chat'])

export function createDispositionWiring({
  scheduler,
  ownerId,
  agentId,
  ignoreIds,
  presenceWindowMs,
  onKickCommand,
  now = () => Date.now(),
  log = () => {},
}) {
  if (!scheduler) throw new Error('scheduler is required')
  let lastSkipActivityAt = 0          // 0 = Skip unseen → absent (pokeable)
  const cwdCache = new Map()           // agentId → cwd
  const knownBotIds = new Set([...ignoreIds].filter(id => id !== ownerId))
  knownBotIds.add(agentId)
  const lastInboundFrom = new Map()    // agentId → from_id of the message that triggered its current turn
  const workedThisTurn = new Set()     // agentIds that emitted a real-work tool since their last turn end

  return {
    // Read at scheduler fire time: he's present iff he chatted within the window.
    isSkipPresent: () => now() - lastSkipActivityAt < presenceWindowMs,

    // Lane lookup for the poke text; unknown agent → null → generic poke.
    cwdOf: (id) => cwdCache.get(id) || null,

    // The bot calls this as it pokes, so a post-poke turn is recognized as
    // bot-triggered even if the bot doesn't see its own outgoing chat echoed.
    notePoked: (id) => { if (id) lastInboundFrom.set(id, agentId) },

    // Fold the alive roster (store-agents) into the cwd cache. Best-effort:
    // a non-array (failed fetch) is a no-op, leaving the prior cache intact.
    updateRoster: (agents) => {
      if (!Array.isArray(agents)) return
      knownBotIds.clear()
      knownBotIds.add(agentId)
      for (const id of ignoreIds) if (id !== ownerId) knownBotIds.add(id)
      for (const a of agents) {
        if (a?.id && typeof a.cwd === 'string' && a.cwd) cwdCache.set(a.id, a.cwd)
        const labels = Array.isArray(a?.labels) ? a.labels : []
        if (a?.id && (labels.includes('bot') || a.human)) knownBotIds.add(a.id)
      }
    },

    // Dispatch one fleet-event payload (msg.data) to the scheduler.
    handleFleetEvent: (d) => {
      if (!d) return

      if (d.type === 'chat') {
        // Track the trigger of the recipient's turn (any sender — Skip, another
        // agent, or the bot's own poke). A later inbound overrides an earlier one.
        if (d.to_id && d.to_id !== d.from_id) lastInboundFrom.set(d.to_id, d.from_id)
        if (d.from_id === ownerId) {
          lastSkipActivityAt = now()                                  // presence (global)
          if (d.to_id && d.to_id !== agentId) scheduler.onSkipMessage(d.to_id) // in the room with that agent
          if (d.to_id === agentId && d.text) onKickCommand(d.text)    // manual kick to the bot
        }
        return
      }

      if (d.type === 'activity') {
        // Activity events are self-addressed (from_id === to_id === agent). A
        // non-comment tool means the agent did real work this turn. metadata.tool
        // is the authoritative tool name the server always sets (don't fall back
        // to d.text — for a text block that's the prose, not the '_text' marker).
        const id = d.from_id || d.agent_id
        const meta = typeof d.metadata === 'string'
          ? (() => { try { return JSON.parse(d.metadata) } catch { return {} } })()
          : (d.metadata || {})
        const tool = meta.tool || ''
        const inputObj = typeof meta.input === 'object' && meta.input ? meta.input : {}
        const chatTarget = inputObj.filter?.to
        const botOrSelfChat = CHAT_TOOLS.has(tool) && chatTarget && (knownBotIds.has(chatTarget) || chatTarget === id)
        if (botOrSelfChat) return
        if (id && tool && !COMMENT_TOOLS.has(tool)) workedThisTurn.add(id)
        return
      }

      if (d.type === 'turn_ended') {
        const id = d.agent_id || d.from_id
        if (!id || ignoreIds.has(id)) return
        const triggeredByBot = lastInboundFrom.get(id) === agentId
        const didWork = workedThisTurn.has(id)
        // This turn is over — consume its per-turn trigger/work state so the
        // NEXT turn (which may be autonomous, with no new inbound) starts clean.
        lastInboundFrom.delete(id)
        workedThisTurn.delete(id)
        if (triggeredByBot) {
          log(didWork ? 'suppress-bot-triggered-work' : 'suppress-poke-loop', id)
          return
        }
        scheduler.onTurnEnd(id)
      }
    },

    // Test/introspection helpers.
    _lastSkipActivityAt: () => lastSkipActivityAt,
  }
}
