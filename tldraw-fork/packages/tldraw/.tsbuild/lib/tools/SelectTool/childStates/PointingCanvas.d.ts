import { StateNode, TLClickEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class PointingCanvas extends StateNode {
    static id: string;
    onEnter(info: TLPointerEventInfo & {
        target: 'canvas';
    }): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onComplete(): void;
    onInterrupt(): void;
    private complete;
}
//# sourceMappingURL=PointingCanvas.d.ts.map