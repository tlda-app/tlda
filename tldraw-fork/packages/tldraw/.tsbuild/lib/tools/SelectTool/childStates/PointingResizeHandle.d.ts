import { StateNode, TLClickEventInfo, TLCursorType, TLPointerEventInfo, TLSelectionHandle } from '@tldraw/editor';
export declare const CursorTypeMap: Record<TLSelectionHandle, TLCursorType>;
type PointingResizeHandleInfo = Extract<TLPointerEventInfo, {
    target: 'selection';
}> & {
    onInteractionEnd?: string | (() => void);
};
export declare class PointingResizeHandle extends StateNode {
    static id: string;
    private info;
    private updateCursor;
    onEnter(info: PointingResizeHandleInfo): void;
    onExit(): void;
    onPointerMove(): void;
    onLongPress(): void;
    private startResizing;
    onPointerUp(): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private complete;
    private cancel;
}
export {};
//# sourceMappingURL=PointingResizeHandle.d.ts.map