import { agyActivityTick } from '../agent-runtime/agy-activity.mjs'

export function createAgySupervisor({
  log,
  getAgents,
  bufferActivity,
  isNoise,
  activityMs = 3000,
  home,
}) {
  const activityLastSeen = new Map()
  let activityInterval = null

  function startActivityPolling() {
    if (activityInterval) return
    activityInterval = setInterval(() => {
      agyActivityTick(getAgents(), {
        bufferActivity,
        log,
        lastSeen: activityLastSeen,
        isNoise,
        home,
      })
    }, activityMs)
  }

  return {
    startActivityPolling,
  }
}
