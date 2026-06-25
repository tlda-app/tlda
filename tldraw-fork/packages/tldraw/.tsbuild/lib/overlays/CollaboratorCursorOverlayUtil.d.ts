import { OverlayUtil, TLOverlay } from '@tldraw/editor';
/** @public */
export interface TLCollaboratorCursorOverlay extends TLOverlay {
    props: {
        x: number;
        y: number;
        color: string;
        name: string | null;
        chatMessage: string;
    };
}
/**
 * Overlay util for collaborator cursors (arrow + name tag + chat message).
 *
 * @public
 */
export declare class CollaboratorCursorOverlayUtil extends OverlayUtil<TLCollaboratorCursorOverlay> {
    static type: string;
    options: {
        zIndex: number;
        fontSize: number;
        nameMaxWidth: number;
        chatMaxWidth: number;
    };
    private _truncateCache;
    isActive(): boolean;
    getOverlays(): TLCollaboratorCursorOverlay[];
    render(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorCursorOverlay[]): void;
    /** Name tag (no chat) - colored background with white text */
    private _drawNameTag;
    /** Name title (when chat is present) - text with shadow, no background */
    private _drawNameTitle;
    /** Chat bubble - colored background with white text */
    private _drawChatBubble;
    renderMinimap(ctx: CanvasRenderingContext2D, overlays: TLCollaboratorCursorOverlay[], zoom: number): void;
    private _truncateText;
    private _setTruncatedTextCache;
}
//# sourceMappingURL=CollaboratorCursorOverlayUtil.d.ts.map