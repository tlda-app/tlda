import { TLShapeId, VecModel } from '@tldraw/tlschema';
import { Box, SelectionCorner, SelectionEdge } from '../../../primitives/Box';
import { Vec } from '../../../primitives/Vec';
import type { Editor } from '../../Editor';
import type { SnapData, SnapManager } from './SnapManager';
/**
 * When moving or resizing shapes, the bounds of the shape can snap to key geometry on other nearby
 * shapes. Customize how a shape snaps to others with {@link ShapeUtil.getBoundsSnapGeometry}.
 *
 * @public
 */
export interface BoundsSnapGeometry {
    /**
     * Points that this shape will snap to. By default, this will be the corners and center of the
     * shapes bounding box. To disable snapping to a specific point, use an empty array.
     */
    points?: VecModel[];
}
/** @public */
export interface BoundsSnapPoint {
    id: string;
    x: number;
    y: number;
    handle?: SelectionCorner;
}
/** @public */
export declare class BoundsSnaps {
    readonly manager: SnapManager;
    readonly editor: Editor;
    constructor(manager: SnapManager);
    private getSnapPointsCache;
    getSnapPoints(shapeId: TLShapeId): BoundsSnapPoint[];
    private getSnappablePoints;
    private getSnappableGapNodes;
    private getVisibleGaps;
    snapTranslateShapes({ lockedAxis, initialSelectionPageBounds, initialSelectionSnapPoints, dragDelta }: {
        dragDelta: Vec;
        initialSelectionPageBounds: Box;
        initialSelectionSnapPoints: BoundsSnapPoint[];
        lockedAxis: 'x' | 'y' | null;
    }): SnapData;
    snapResizeShapes({ initialSelectionPageBounds, dragDelta, handle: originalHandle, isAspectRatioLocked, isResizingFromCenter }: {
        dragDelta: Vec;
        handle: SelectionCorner | SelectionEdge;
        initialSelectionPageBounds: Box;
        isAspectRatioLocked: boolean;
        isResizingFromCenter: boolean;
    }): SnapData;
    private collectPointSnaps;
    private collectGapSnaps;
    private getPointSnapLines;
    private getGapSnapLines;
}
//# sourceMappingURL=BoundsSnaps.d.ts.map