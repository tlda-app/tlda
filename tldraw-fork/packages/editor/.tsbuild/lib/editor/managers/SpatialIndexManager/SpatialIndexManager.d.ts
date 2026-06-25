import { TLShapeId } from '@tldraw/tlschema';
import { Box } from '../../../primitives/Box';
import type { Editor } from '../../Editor';
/**
 * Manages spatial indexing for efficient shape location queries.
 *
 * Uses an R-tree (via RBush) to enable O(log n) spatial queries instead of O(n) iteration.
 * Handles shapes with computed bounds (arrows, groups, custom shapes) by checking all shapes'
 * bounds on each update using the reactive bounds cache.
 *
 * Key features:
 * - Incremental updates using filterHistory pattern
 * - Leverages existing bounds cache reactivity for dependency tracking
 * - Works with any custom shape type with computed bounds
 * - Per-page index (rebuilds on page change)
 * - Optimized for viewport culling queries
 *
 * @internal
 */
export declare class SpatialIndexManager {
    readonly editor: Editor;
    private rbush;
    private spatialIndexComputed;
    private lastPageId;
    private _boundsEpoch;
    constructor(editor: Editor);
    private rebuildAndBumpEpoch;
    private createSpatialIndexComputed;
    private buildFromScratch;
    private processIncrementalUpdate;
    private areBoundsEqualToSpatialElement;
    /**
     * Get shape IDs within the given bounds.
     * Optimized for viewport culling queries.
     *
     * Note: Results are unordered. If you need z-order, combine with sorted shapes:
     * ```ts
     * const candidates = editor.spatialIndex.getShapeIdsInsideBounds(bounds)
     * const sorted = editor.getCurrentPageShapesSorted().filter(s => candidates.has(s.id))
     * ```
     *
     * @param bounds - The bounds to search within
     * @returns Unordered set of shape IDs within the bounds
     *
     * @public
     */
    getShapeIdsInsideBounds(bounds: Box): Set<TLShapeId>;
    /**
     * Get shape IDs at a point (with optional margin).
     * Creates a small bounding box around the point and searches the spatial index.
     *
     * Note: Results are unordered. If you need z-order, combine with sorted shapes:
     * ```ts
     * const candidates = editor.spatialIndex.getShapeIdsAtPoint(point, margin)
     * const sorted = editor.getCurrentPageShapesSorted().filter(s => candidates.has(s.id))
     * ```
     *
     * @param point - The point to search at
     * @param margin - The margin around the point to search (default: 0)
     * @returns Unordered set of shape IDs that could potentially contain the point
     *
     * @public
     */
    getShapeIdsAtPoint(point: {
        x: number;
        y: number;
    }, margin?: number): Set<TLShapeId>;
    /**
     * Dispose of the spatial index manager.
     * Clears the R-tree to prevent memory leaks.
     *
     * @public
     */
    dispose(): void;
}
//# sourceMappingURL=SpatialIndexManager.d.ts.map