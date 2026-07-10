const PLAN_MODE_RESPONSE_KEYS = {
  approve: '1',
  supervised: '2',
  reject: '3',
}

export function planModeResponseKey(response) {
  return PLAN_MODE_RESPONSE_KEYS[response] || null
}

export function isPlanModeResponse(response) {
  return planModeResponseKey(response) !== null
}
