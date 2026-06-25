import { TLHandle, TLShapeId, VecModel } from '@tldraw/tlschema';
import { Geometry2d } from '../../../primitives/geometry/Geometry2d';
import type { Editor } from '../../Editor';
import type { SnapData, SnapManager } from './SnapManager';
/**
 * When dragging a handle, users can snap the handle to key geometry on other nearby shapes.
 * Customize how handles snap to a shape by returning this from
 * {@link ShapeUtil.getHandleSnapGeometry}.
 *
 * Any co-ordinates here should be in the shape's local space.
 *
 * @public
 */
export interface HandleSnapGeometry {
    /**
     * A `Geometry2d` that describe the outline of the shape that the handle will snap to - fills
     * are ignored. By default, this is the same geometry returned by {@link ShapeUtil.getGeometry}.
     * Set this to `null` to disable handle snapping to this shape's outline.
     */
    outline?: Geometry2d | null;
    /**
     * Key points on the shape that the handle will snap to. For example, the corners of a
     * rectangle, or the centroid of a triangle. By default, no points are used.
     */
    points?: VecModel[];
    /**
     * By default, handles can't snap to their own shape because moving the handle might change the
     * snapping location which can cause feedback loops. You can override this by returning a
     * version of `outline` that won't be affected by the current handle's position to use for
     * self-snapping.
     */
    getSelfSnapOutline?(handle: TLHandle): Geometry2d | null;
    /**
     * By default, handles can't snap to their own shape because moving the handle might change the
     * snapping location which can cause feedback loops. You can override this by returning a
     * version of `points` that won't be affected by the current handle's position to use for
     * self-snapping.
     */
    getSelfSnapPoints?(handle: TLHandle): VecModel[];
}
/** @public */
export declare class HandleSnaps {
    readonly manager: SnapManager;
    readonly editor: Editor;
    constructor(manager: SnapManager);
    private getSnapGeometryCache;
    private iterateSnapPointsInPageSpace;
    private iterateSnapOutlines;
    private getHandleSnapPosition;
    private getHandleSnapData;
    snapHandle({ currentShapeId, handle }: {
        currentShapeId: TLShapeId;
        handle: TLHandle;
    }): SnapData | null;
}
//# sourceMappingURL=HandleSnaps.d.ts.map