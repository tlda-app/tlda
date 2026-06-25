import { OverlayUtil, TLOverlay } from '@tldraw/editor';
/** @public */
export interface TLCollaboratorBrushOverlay extends TLOverlay {
    props: {
        x: number;
        y: number;
        w: number;
        h: number;
        color: string;
    };
}
/**
 * Overlay util for collaborator selection brushes.
 *
 * @public
 */
export declare class CollaboratorBrushOverlayUtil extends OverlayUtil<TLCollaboratorBrushOverlay> {
    static type: string;
    options: {
        zIndex: number;
        lineWidth: number;
    };
    isActive(): boolean;
    getOverlays(): TLCollaboratorBrushOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorBrushOverlay[]): void;
    renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorBrushOverlay[]): void;
}
//# sourceMappingURL=CollaboratorBrushOverlayUtil.d.ts.map