export function shouldTerminateForMissedPong(lastPongAt, now, intervalMs) {
  return now - lastPongAt > intervalMs * 2
}

export function socketCanAcceptMore(ws, highWaterMark = 512 * 1024) {
  return ws.readyState === 1 && ws.bufferedAmount < highWaterMark
}
