import type { TLShape } from 'tldraw'
import { FLEET_SHAPE_TYPES } from './fleet-panel-registry.ts'

export function isFleetDocviewContentShape(shape: TLShape): boolean {
  return !FLEET_SHAPE_TYPES.has(shape.type as string)
}
