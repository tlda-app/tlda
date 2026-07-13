export function shouldTerminateForMissedPong(lastPongAt, lastPingAt, now, intervalMs) {
  if (!lastPingAt) return false
  if (lastPongAt >= lastPingAt) return false
  return now - lastPingAt >= intervalMs
}

export function shouldSkipHeartbeatSweepForLag(
  lagMaxMs,
  graceMs = 1000,
  lastLagAt = 0,
  now = Date.now(),
  cooldownMs = 60_000,
  sweepDelayMs = 0,
) {
  if (sweepDelayMs >= graceMs) return true
  if (lagMaxMs >= graceMs) return true
  return !!lastLagAt && now - lastLagAt <= cooldownMs
}

export function clearTrustedHeartbeatProbes(sockets) {
  for (const ws of sockets) ws._wsLastPingAt = 0
}

export function socketCanAcceptMore(ws, highWaterMark = 512 * 1024) {
  return ws.readyState === 1 && ws.bufferedAmount < highWaterMark
}
