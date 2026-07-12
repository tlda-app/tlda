export function shouldTerminateForMissedPong(lastPongAt, now, intervalMs) {
  return now - lastPongAt > intervalMs * 2
}

export function shouldSkipHeartbeatSweepForLag(lagMaxMs, graceMs = 5000) {
  return lagMaxMs >= graceMs
}

export function socketCanAcceptMore(ws, highWaterMark = 512 * 1024) {
  return ws.readyState === 1 && ws.bufferedAmount < highWaterMark
}
