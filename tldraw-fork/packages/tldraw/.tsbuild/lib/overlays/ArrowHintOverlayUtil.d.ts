import { OverlayUtil, TLOverlay, TLShapeId } from '@tldraw/editor';
/** @public */
export interface TLArrowHintOverlay extends TLOverlay {
    props: {
        targetId: TLShapeId;
        handles: {
            top: {
                x: number;
                y: number;
                isEnabled: boolean;
            };
            bottom: {
                x: number;
                y: number;
                isEnabled: boolean;
            };
            left: {
                x: number;
                y: number;
                isEnabled: boolean;
            };
            right: {
                x: number;
                y: number;
                isEnabled: boolean;
            };
        };
        anchorX: number;
        anchorY: number;
        snap: string;
        isExact: boolean;
        isPrecise: boolean;
        arrowKind: string;
        showEdgeHints: boolean;
    };
}
/**
 * Overlay util for arrow target hints (target shape indicator + edge snap circles).
 *
 * @public
 */
export declare class ArrowHintOverlayUtil extends OverlayUtil<TLArrowHintOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
        edgeRadius: number;
        edgePointRadius: number;
        handleRadius: number;
    };
    isActive(): boolean;
    getOverlays(): TLArrowHintOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLArrowHintOverlay[]): void;
    /** @internal */
    private _renderIndicatorPath;
}
//# sourceMappingURL=ArrowHintOverlayUtil.d.ts.map