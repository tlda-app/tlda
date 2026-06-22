import { Vec } from '@tldraw/editor';
import type { StrokeOptions, StrokePoint } from './types';
/**
 * @internal
 */
export declare function getStrokeOutlineTracks(strokePoints: StrokePoint[], options?: StrokeOptions): {
    left: Vec[];
    right: Vec[];
};
/**
 * ## getStrokeOutlinePoints
 *
 * Get an array of points (as `[x, y]`) representing the outline of a stroke.
 *
 * @param points - An array of StrokePoints as returned from `getStrokePoints`.
 * @param options - An object with options.
 * @public
 */
export declare function getStrokeOutlinePoints(strokePoints: StrokePoint[], options?: StrokeOptions): Vec[];
//# sourceMappingURL=getStrokeOutlinePoints.d.ts.map