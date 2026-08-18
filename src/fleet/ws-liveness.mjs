// When is an open websocket actually dead?
//
// A socket whose server was replaced without a clean close stays in readyState
// 1 forever: no close, no error, no data. The client believes it is connected
// and never enters its reconnect path. This is the rule that decides otherwise,
// kept out of fleet-data.mjs so it can be tested without a browser.
//
// The signal is INBOUND silence — time since the server last sent anything —
// not whether our own heartbeat was answered. A heartbeat reply can be delayed
// by an overloaded server while the socket is still good; total silence for
// far longer than any reply delay cannot.

/**
 * @param {object} state
 * @param {number|null} state.readyState  WebSocket.readyState; only 1 (OPEN) can be silently dead.
 * @param {number} state.lastActivityAt   ms epoch of the last inbound frame, or 0 if none yet.
 * @param {number} state.now              ms epoch.
 * @param {number} state.thresholdMs      silence past which we force a reconnect.
 */
export function shouldForceReconnectForSilence({ readyState, lastActivityAt, now, thresholdMs }) {
  // Not open: a closing or closed socket already has a path that handles it,
  // and CONNECTING is the never-opened case the connect watchdog owns.
  if (readyState !== 1) return false
  // Nothing has ever arrived on this socket. lastActivityAt is stamped on open,
  // so 0 means we are not in a position to judge -- treating it as "silent
  // since the epoch" would force a reconnect the instant the timer first ran.
  if (!lastActivityAt) return false
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false
  return now - lastActivityAt > thresholdMs
}
