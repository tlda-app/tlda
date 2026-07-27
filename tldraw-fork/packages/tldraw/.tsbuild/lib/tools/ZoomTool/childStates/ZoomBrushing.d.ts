import { Box, StateNode, TLPointerEventInfo } from '@tldraw/editor';
export declare class ZoomBrushing extends StateNode {
    static id: string;
    info: TLPointerEventInfo & {
        onInteractionEnd?: string | undefined;
    };
    zoomBrush: Box;
    onEnter(info: TLPointerEventInfo & {
        onInteractionEnd: string;
    }): void;
    onExit(): void;
    onPointerMove(): void;
    onPointerUp(): void;
    onCancel(): void;
    private update;
    private cancel;
    private complete;
}
//# sourceMappingURL=ZoomBrushing.d.ts.map