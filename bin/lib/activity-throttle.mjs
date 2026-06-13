// Per-agent leading-edge throttle for daemon activity events.
//
// The first activity from an agent that has been quiet for >= windowMs flushes
// IMMEDIATELY — so the card shows up in fleet chat the moment the agent acts,
// instead of trailing the terminal by the full window. Further events inside
// the window batch and flush once at the window boundary, which preserves the
// anti-spam bound (at most one push per window) for a chatty agent. Per-agent
// (not global) so a busy fleet never penalizes the one agent Skip is watching.
//
// The old design used a single trailing timer for ALL agents, so every event —
// even the first after an idle gap — waited the full window: the chat-lags-
// terminal bug.
//
// Dependencies are injected so the timing can be exercised with a fake clock in
// tests without real timers. `send(agentId, evt)` is called once per buffered
// event at flush time.
export function makeActivityThrottle({
  send,
  windowMs = 2000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const buf = new Map()        // agentId -> evt[]
  const timer = new Map()      // agentId -> timer handle (flush scheduled this window)
  const lastFlush = new Map()  // agentId -> ms timestamp of last flush

  function flush(agentId) {
    const t = timer.get(agentId)
    if (t !== undefined) { clearTimer(t); timer.delete(agentId) }
    lastFlush.set(agentId, now())
    const list = buf.get(agentId)
    buf.delete(agentId)
    if (!list || list.length === 0) return
    for (const evt of list) send(agentId, evt)
  }

  function buffer(agentId, evts) {
    const list = buf.get(agentId) || []
    list.push(...evts)
    buf.set(agentId, list)
    // A flush is already scheduled for this window — let it carry these events.
    if (timer.has(agentId)) return
    const sinceLast = now() - (lastFlush.get(agentId) || 0)
    if (sinceLast >= windowMs) {
      flush(agentId)  // leading edge: agent was quiet, send now
    } else {
      // Inside the window after a recent flush — schedule the trailing batch at
      // the window boundary so the push rate stays bounded.
      timer.set(agentId, setTimer(() => flush(agentId), windowMs - sinceLast))
    }
  }

  return { buffer }
}
