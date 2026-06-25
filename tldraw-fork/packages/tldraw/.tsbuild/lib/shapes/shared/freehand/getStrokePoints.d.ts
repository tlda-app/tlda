import { VecLike } from '@tldraw/editor';
import type { StrokeOptions, StrokePoint } from './types';
/**
 * ## getStrokePoints
 *
 * Get an array of points as objects with an adjusted point, pressure, vector, distance, and
 * runningLength.
 *
 * @param points - An array of points (as `[x, y, pressure]` or `{x, y, pressure}`). Pressure is
 *   optional in both cases.
 * @param options - An object with options.
 * @public
 */
export declare function getStrokePoints(rawInputPoints: VecLike[], options?: StrokeOptions): StrokePoint[];
//# sourceMappingURL=getStrokePoints.d.ts.map