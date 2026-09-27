// Freshness annotation for the trusted-idle map. Pure: the server collects
// the timestamps, this shapes them. A touch age of null means the idle for
// that agent rests on the aliveSince fallback — no touch has been processed
// for it this server run. The daemon-pipe canary is the age of the most
// recently processed daemon-pipe touch (activity-event, agent-status,
// admitted heartbeat); it grows while idles go stale under a delivery stall,
// which is the signature the 21:10:31Z hibernate of a working agent showed.
// Null when nothing has been processed this run (cold server). Second
// resolution matches the idle figures. Future timestamps clamp to zero rather
// than reporting a negative age on clock skew.
export function annotateIdleFreshness({
  idleSecondsByAgent = {},
  touchAtMsByAgent = {},
  daemonPipeTouchAtMs = null,
  nowMs = Date.now(),
} = {}) {
  const ageSecs = atMs =>
    Number.isFinite(atMs) ? Math.max(0, Math.floor((nowMs - atMs) / 1000)) : null
  const touchAgeSecondsByAgent = {}
  for (const [agentId, touchAtMs] of Object.entries(touchAtMsByAgent)) {
    touchAgeSecondsByAgent[agentId] = ageSecs(touchAtMs)
  }
  return {
    idleSecondsByAgent,
    touchAgeSecondsByAgent,
    freshness: {
      computedAt: new Date(nowMs).toISOString(),
      daemonPipeTouchAgeSecs: ageSecs(daemonPipeTouchAtMs),
    },
  }
}
