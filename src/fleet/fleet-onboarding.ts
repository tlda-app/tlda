export const FLEET_AGENT_CHAT_DROP_EVENT = 'fleet-agent-chat-drop'

const FLEET_GUIDE_STATE_PREFIX = 'tlda:fleet-guide-state'

export type FleetGuideState = 'not-started' | 'active' | 'done'

function fleetGuideKey(userId: string, deviceId: string) {
  return `${FLEET_GUIDE_STATE_PREFIX}:${userId}:${deviceId}`
}

export function readFleetGuideState(userId: string, deviceId: string): FleetGuideState {
  if (!userId || !deviceId) return 'not-started'
  try {
    const value = window.localStorage.getItem(fleetGuideKey(userId, deviceId))
    return value === 'active' || value === 'done' ? value : 'not-started'
  } catch {
    return 'not-started'
  }
}

function writeFleetGuideState(userId: string, deviceId: string, state: FleetGuideState) {
  if (!userId || !deviceId) return
  try {
    window.localStorage.setItem(fleetGuideKey(userId, deviceId), state)
  } catch {
    // The caller also updates mounted state, so storage failure is non-fatal.
  }
}

export function startFleetGuide(userId: string, deviceId: string) {
  writeFleetGuideState(userId, deviceId, 'active')
}

export function dismissFleetGuide(userId: string, deviceId: string) {
  writeFleetGuideState(userId, deviceId, 'done')
}

export function completeFleetAgentChatDrop(userId: string, deviceId: string) {
  dismissFleetGuide(userId, deviceId)
  window.dispatchEvent(new CustomEvent(FLEET_AGENT_CHAT_DROP_EVENT))
}
