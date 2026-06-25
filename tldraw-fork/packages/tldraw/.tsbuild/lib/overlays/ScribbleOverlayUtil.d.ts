import { OverlayUtil, TLOverlay, TLScribble } from '@tldraw/editor';
/** @public */
export interface TLScribbleOverlay extends TLOverlay {
    props: {
        scribble: TLScribble;
    };
}
/**
 * Overlay util for scribble strokes (eraser, lasso selection, etc.).
 *
 * @public
 */
export declare class ScribbleOverlayUtil extends OverlayUtil<TLScribbleOverlay> {
    static type: string;
    options: {
        zIndex: number;
        streamline: number;
        cacheSize: number;
    };
    private _scribblePathCache;
    isActive(): boolean;
    getOverlays(): TLScribbleOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLScribbleOverlay[]): void;
}
//# sourceMappingURL=ScribbleOverlayUtil.d.ts.map