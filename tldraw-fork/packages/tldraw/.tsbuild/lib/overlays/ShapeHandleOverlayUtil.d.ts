import { Geometry2d, OverlayUtil, TLCursorType, TLHandle, TLOverlay, TLShapeId } from '@tldraw/editor';
/** @public */
export interface TLShapeHandleOverlay extends TLOverlay {
    props: {
        shapeId: TLShapeId;
        handle: TLHandle;
    };
}
/**
 * Overlay util for shape handles (arrow endpoints, line vertices, etc.).
 *
 * @public
 */
export declare class ShapeHandleOverlayUtil extends OverlayUtil<TLShapeHandleOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
    };
    isActive(): boolean;
    getOverlays(): TLShapeHandleOverlay[];
    getGeometry(overlay: TLShapeHandleOverlay): Geometry2d | null;
    getCursor(_overlay: TLShapeHandleOverlay): TLCursorType | undefined;
    render(ctx: CanvasRenderingContext2D, overlays: TLShapeHandleOverlay[]): void;
}
//# sourceMappingURL=ShapeHandleOverlayUtil.d.ts.map