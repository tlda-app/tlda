import { OverlayUtil, TLOverlay } from '@tldraw/editor';
/** @public */
export interface TLCollaboratorHintOverlay extends TLOverlay {
    props: {
        /** Clamped point on viewport edge, in page coordinates */
        x: number;
        y: number;
        /** Rotation angle pointing toward the collaborator's actual cursor */
        rotation: number;
        color: string;
    };
}
/**
 * Overlay util for off-screen collaborator cursor hints.
 * Shows a small directional arrow at the viewport edge pointing toward the collaborator.
 *
 * @public
 */
export declare class CollaboratorHintOverlayUtil extends OverlayUtil<TLCollaboratorHintOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
        viewportPadding: number;
    };
    isActive(): boolean;
    getOverlays(): TLCollaboratorHintOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorHintOverlay[]): void;
    /** @internal */
    private _isCursorInViewport;
}
//# sourceMappingURL=CollaboratorHintOverlayUtil.d.ts.map