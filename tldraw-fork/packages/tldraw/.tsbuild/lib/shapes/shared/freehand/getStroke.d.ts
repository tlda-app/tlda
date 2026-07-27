import { Vec, VecLike } from '@tldraw/editor';
import type { StrokeOptions } from './types';
/**
 * ## getStroke
 *
 * Get an array of points describing a polygon that surrounds the input points.
 *
 * @param points - An array of points (as `[x, y, pressure]` or `{x, y, pressure}`). Pressure is
 *   optional in both cases.
 * @param options - An object with options.
 * @public
 */
export declare function getStroke(points: VecLike[], options?: StrokeOptions): Vec[];
//# sourceMappingURL=getStroke.d.ts.map