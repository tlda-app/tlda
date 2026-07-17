export function isPhoneFleetDefaultViewport({
  width,
  height,
  pointerCoarse,
  maxTouchPoints,
}: {
  width: number
  height: number
  pointerCoarse: boolean
  maxTouchPoints: number
}): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  const hasPhoneInputCapability = pointerCoarse || maxTouchPoints > 0
  if (!hasPhoneInputCapability) return false
  const shortSide = Math.min(width, height)
  const longSide = Math.max(width, height)
  return shortSide <= 600 && longSide <= 950
}

export function selectAutoFleetDefaultLayout({
  explicitLayout,
  automatedSession,
  phoneViewport,
  ownedFleetShapeCount,
}: {
  explicitLayout: boolean
  automatedSession: boolean
  phoneViewport: boolean
  ownedFleetShapeCount: number
}): 'single-chat' | '3-col' | null {
  if (explicitLayout || ownedFleetShapeCount !== 0) return null
  if (automatedSession) return '3-col'
  if (phoneViewport) return 'single-chat'
  return null
}
