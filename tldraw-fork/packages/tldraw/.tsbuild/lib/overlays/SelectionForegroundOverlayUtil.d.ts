import { Geometry2d, OverlayUtil, RotateCorner, TLCursorType, TLOverlay, TLSelectionHandle } from '@tldraw/editor';
/** @public */
export interface TLSelectionForegroundOverlay extends TLOverlay {
    props: {
        overlayType: 'resize_handle' | 'rotate_handle' | 'mobile_rotate';
        handle: TLSelectionHandle | RotateCorner;
    };
}
/**
 * Overlay util for selection foreground handles (resize corners/edges, rotate corners, mobile rotate).
 * Each interactive element of the selection foreground becomes its own overlay instance.
 *
 * @public
 */
export declare class SelectionForegroundOverlayUtil extends OverlayUtil<TLSelectionForegroundOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
    };
    isActive(): boolean;
    getOverlays(): TLSelectionForegroundOverlay[];
    getGeometry(overlay: TLSelectionForegroundOverlay): Geometry2d | null;
    render(ctx: CanvasRenderingContext2D, _overlays: TLSelectionForegroundOverlay[]): void;
    getCursor(overlay: TLSelectionForegroundOverlay): TLCursorType | undefined;
    private _collectResizeCornerOverlays;
    private _collectResizeEdgeOverlays;
    private _collectRotateOverlays;
    private _getResizeHandleGeometry;
    private _getRotateHandleGeometry;
    private _getMobileRotateGeometry;
    private _renderSelectionBox;
    private _renderResizeCorners;
    private _renderCropHandles;
    private _renderMobileRotateHandle;
    private _renderTextResizeHandles;
    /**
     * Single source of truth for the derived state the selection foreground needs.
     * Called from `getOverlays()`, `getGeometry()`, and `render()` so their visibility
     * predicates can't drift. Returns `null` when no selection UI should appear at all
     * (nothing selected, or the only selected shape is hidden).
     */
    private _computeSelectionState;
    private _getMobileRotateCenter;
    private _getThemeColors;
    private _makeOverlay;
    private _getEdgeLocalRect;
    private _getRotateHandleLocalCenter;
    private _getCornerLocalPoint;
    private _localRectToPoints;
}
//# sourceMappingURL=SelectionForegroundOverlayUtil.d.ts.map