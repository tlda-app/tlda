import type { TLDrawShapeSegment, VecModel } from '@tldraw/editor';
/**
 * Helper function to convert draw shape points from VecModel[] to base64 string.
 * Uses delta encoding for improved Float16 precision.
 * This is useful for tests that create draw shapes with the legacy array format.
 *
 * @example
 * ```ts
 * const segments = [{ type: 'free', path: pointsToBase64([{x: 0, y: 0, z: 0.5}]) }]
 * ```
 *
 * @public
 */
export declare function pointsToBase64(points: VecModel[]): string;
/**
 * Helper function to convert base64 string back to VecModel[] points.
 * Decodes delta-encoded points to absolute coordinates.
 * This is useful for tests that need to inspect draw shape points.
 *
 * @example
 * ```ts
 * const points = base64ToPoints(shape.props.segments[0].path)
 * expect(points[0].x).toBe(0)
 * ```
 *
 * @public
 */
export declare function base64ToPoints(base64: string): VecModel[];
/**
 * Helper function to create draw shape segments from legacy array format.
 * This allows tests to use the old format while the shape uses the new base64 format.
 *
 * @example
 * ```ts
 * editor.createShapes([{
 *   type: 'draw',
 *   props: {
 *     segments: createDrawSegments([[{x: 0, y: 0}, {x: 10, y: 10}]])
 *   }
 * }])
 * ```
 * @public
 */
export declare function createDrawSegments(pointArrays: VecModel[][], type?: 'free' | 'straight'): TLDrawShapeSegment[];
//# sourceMappingURL=test-helpers.d.ts.map