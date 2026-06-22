import { OverlayUtil, SnapIndicator, TLOverlay } from '@tldraw/editor';
/** @public */
export interface TLSnapIndicatorOverlay extends TLOverlay {
    props: {
        line: SnapIndicator;
    };
}
/**
 * Overlay util for snap alignment indicators (point snap lines and gap indicators).
 *
 * @public
 */
export declare class SnapIndicatorOverlayUtil extends OverlayUtil<TLSnapIndicatorOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
    };
    isActive(): boolean;
    getOverlays(): TLSnapIndicatorOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLSnapIndicatorOverlay[]): void;
    private _renderPoints;
    private _renderGaps;
}
//# sourceMappingURL=SnapIndicatorOverlayUtil.d.ts.map