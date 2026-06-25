import { OverlayUtil, TLOverlay, TLShapeId } from '@tldraw/editor';
/** @public */
export interface TLArrowBindingHintOverlay extends TLOverlay {
    props: {
        arrowId: TLShapeId;
    };
}
/**
 * Overlay util for the dashed binding hint shown on bound arrows. Draws stubs
 * along the arrow's handle path, from each bound endpoint's snapped body
 * position to the user's intended (handle) position, with a precision marker
 * at the handle.
 *
 * @public
 */
export declare class ArrowBindingHintOverlayUtil extends OverlayUtil<TLArrowBindingHintOverlay> {
    static type: string;
    options: {
        zIndex: number;
        strokeWidth: number;
        opacity: number;
        dashLengthRatio: number;
        dotRadius: number;
        crossSize: number;
        dashedMinZoom: number;
    };
    isActive(): boolean;
    getOverlays(): TLArrowBindingHintOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLArrowBindingHintOverlay[]): void;
    private drawEndpoint;
    /** Tangent direction at the handle, oriented toward the body. */
    private getMarkerAngle;
}
//# sourceMappingURL=ArrowBindingHintOverlayUtil.d.ts.map