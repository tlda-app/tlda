export function shouldTerminateForMissedPong(lastPongAt, now, intervalMs) {
  return now - lastPongAt > intervalMs * 2
}

export function shouldSkipHeartbeatSweepForLag(
  lagMaxMs,
  graceMs = 1000,
  lastLagAt = 0,
  now = Date.now(),
  cooldownMs = 60_000,
) {
  if (lagMaxMs >= graceMs) return true
  return !!lastLagAt && now - lastLagAt <= cooldownMs
}

export function socketCanAcceptMore(ws, highWaterMark = 512 * 1024) {
  return ws.readyState === 1 && ws.bufferedAmount < highWaterMark
}
