import { StateNode, TLClickEventInfo, TLPointerEventInfo } from '@tldraw/editor';
type PointingRotateHandleInfo = Extract<TLPointerEventInfo, {
    target: 'selection';
}> & {
    onInteractionEnd?: string | (() => void);
};
export declare class PointingRotateHandle extends StateNode {
    static id: string;
    private info;
    private updateCursor;
    onEnter(info: PointingRotateHandleInfo): void;
    onExit(): void;
    onPointerMove(): void;
    onLongPress(): void;
    private startRotating;
    onPointerUp(): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private complete;
    private cancel;
}
export {};
//# sourceMappingURL=PointingRotateHandle.d.ts.map