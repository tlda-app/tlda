import { OverlayOptionsWithDisplayValues, OverlayUtil, TLOverlay } from '@tldraw/editor';
/** @public */
export interface TLBrushOverlay extends TLOverlay {
    props: {
        x: number;
        y: number;
        w: number;
        h: number;
    };
}
/** @public */
export interface BrushOverlayUtilDisplayValues {
    fillColor: string;
    strokeColor: string;
    lineWidth: number;
}
/** @public */
export interface BrushOverlayUtilOptions extends OverlayOptionsWithDisplayValues<TLBrushOverlay, BrushOverlayUtilDisplayValues> {
    zIndex: number;
}
/**
 * Overlay util for the selection brush rectangle.
 *
 * @public
 */
export declare class BrushOverlayUtil extends OverlayUtil<TLBrushOverlay> {
    static type: string;
    options: BrushOverlayUtilOptions;
    isActive(): boolean;
    getOverlays(): TLBrushOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLBrushOverlay[]): void;
    renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLBrushOverlay[], zoom: number): void;
}
//# sourceMappingURL=BrushOverlayUtil.d.ts.map