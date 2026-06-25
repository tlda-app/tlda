import { OverlayUtil, TLOverlay } from '@tldraw/editor';
/** @public */
export interface TLZoomBrushOverlay extends TLOverlay {
    props: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}
/**
 * Overlay util for the zoom brush rectangle.
 *
 * @public
 */
export declare class ZoomBrushOverlayUtil extends OverlayUtil<TLZoomBrushOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
    };
    isActive(): boolean;
    getOverlays(): TLZoomBrushOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLZoomBrushOverlay[]): void;
    renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLZoomBrushOverlay[], zoom: number): void;
}
//# sourceMappingURL=ZoomBrushOverlayUtil.d.ts.map