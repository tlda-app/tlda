import { OverlayUtil, TLOverlay, TLScribble } from '@tldraw/editor';
/** @public */
export interface TLCollaboratorScribbleOverlay extends TLOverlay {
    props: {
        scribble: TLScribble;
        color: string;
    };
}
/**
 * Overlay util for collaborator scribble strokes (eraser, lasso, etc.).
 *
 * @public
 */
export declare class CollaboratorScribbleOverlayUtil extends OverlayUtil<TLCollaboratorScribbleOverlay> {
    static type: string;
    options: {
        zIndex: number;
        streamline: number;
        cacheSize: number;
    };
    private _collabScribblePathCache;
    isActive(): boolean;
    getOverlays(): TLCollaboratorScribbleOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorScribbleOverlay[]): void;
}
//# sourceMappingURL=CollaboratorScribbleOverlayUtil.d.ts.map