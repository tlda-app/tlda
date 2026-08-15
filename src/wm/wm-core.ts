export * from '../../packages/tldraw-wm/src/wm-core.ts'

export interface LayerOwner {
  userId: string
  deviceId: string
}

export function createLayerOwner(userId = '', deviceId = ''): LayerOwner {
  return { userId, deviceId }
}
