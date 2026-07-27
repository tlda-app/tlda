import { OverlayUtil, TLOverlay } from '@tldraw/editor';
import { TLShapeId } from '@tldraw/tlschema';
/** @public */
export interface TLShapeIndicatorOverlay extends TLOverlay {
    props: {
        idsToDisplay: TLShapeId[];
        hintingShapeIds: TLShapeId[];
    };
}
/**
 * Overlay util for shape indicators — the selection / hover / hint outlines drawn
 * under the selection foreground. Paints local indicators in the theme's
 * selection color.
 *
 * Remote collaborator selection indicators are drawn by a separate overlay util
 * (e.g. `CollaboratorShapeIndicatorOverlayUtil` from `tldraw`) that runs at a
 * lower z-index so peer selections appear under the local indicators.
 *
 * Non-interactive: contributes no hit-test geometry.
 *
 * @public
 */
export declare class ShapeIndicatorOverlayUtil extends OverlayUtil<TLShapeIndicatorOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
        hintedLineWidth: number;
    };
    private _instanceFlags$;
    isActive(): boolean;
    getOverlays(): TLShapeIndicatorOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLShapeIndicatorOverlay[]): void;
}
//# sourceMappingURL=ShapeIndicatorOverlayUtil.d.ts.map