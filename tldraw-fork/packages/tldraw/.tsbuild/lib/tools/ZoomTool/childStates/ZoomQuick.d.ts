import { Box, StateNode, TLKeyboardEventInfo, TLPointerEventInfo, Vec } from '@tldraw/editor';
export declare class ZoomQuick extends StateNode {
    static id: string;
    info: TLPointerEventInfo & {
        onInteractionEnd?: string | undefined;
    };
    qzState: "idle" | "moving";
    initialVpb: Box;
    initialPp: Vec;
    /** The camera zoom right after the overview zoom-out in onEnter. */
    overviewZoom: number;
    cleanupZoomReactor(): void;
    nextVpb: Box;
    onEnter(info: TLPointerEventInfo & {
        onInteractionEnd: string;
    }): void;
    onExit(): void;
    onPointerUp(): void;
    onCancel(): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    private updateBrush;
    private zoomToNewViewport;
    onPointerMove(): void;
    onTick(): void;
    private getNextVpb;
}
//# sourceMappingURL=ZoomQuick.d.ts.map