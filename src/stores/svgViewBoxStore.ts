/**
 * SVG viewBox dimensions per shape, for coordinate conversion.
 */

export interface SvgViewBox { minX: number; minY: number; width: number; height: number }
export const svgViewBoxStore = new Map<string, SvgViewBox>()

export function getSvgViewBox(shapeId: string): SvgViewBox | undefined {
  return svgViewBoxStore.get(shapeId)
}
