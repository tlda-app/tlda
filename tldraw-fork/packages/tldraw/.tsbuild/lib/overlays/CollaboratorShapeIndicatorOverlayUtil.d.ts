import { OverlayUtil, TLOverlay, TLShapeId } from '@tldraw/editor';
/** @public */
export interface TLCollaboratorShapeIndicatorOverlay extends TLOverlay {
    props: {
        indicators: Array<{
            color: string;
            shapeIds: TLShapeId[];
        }>;
    };
}
/**
 * Overlay util for remote collaborators' shape selection indicators.
 *
 * Renders a per-peer outline around each shape another user has selected,
 * using the peer's color. Drawn under the local `ShapeIndicatorOverlayUtil`
 * (lower z-index) so the local user's selection always appears on top.
 *
 * Non-interactive: contributes no hit-test geometry.
 *
 * @public
 */
export declare class CollaboratorShapeIndicatorOverlayUtil extends OverlayUtil<TLCollaboratorShapeIndicatorOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
        alpha: number;
    };
    isActive(): boolean;
    getOverlays(): TLCollaboratorShapeIndicatorOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorShapeIndicatorOverlay[]): void;
}
//# sourceMappingURL=CollaboratorShapeIndicatorOverlayUtil.d.ts.map