import { StateNode, TLClickEventInfo, TLHandle, TLPointerEventInfo } from '@tldraw/editor';
export declare class PointingHandle extends StateNode {
    static id: string;
    didCtrlOnEnter: boolean;
    info: import("@tldraw/editor").TLBaseEventInfo & {
        type: "pointer";
        name: import("@tldraw/editor").TLPointerEventName;
        point: import("@tldraw/editor").VecLike;
        pointerId: number;
        button: number;
        isPen: boolean;
        isPenDirect?: boolean | undefined;
    } & {
        target: "handle";
        shape: import("@tldraw/tlschema").TLShape;
        handle: TLHandle;
    } & {
        target: "handle";
    };
    onEnter(info: TLPointerEventInfo & {
        target: 'handle';
    }): void;
    onExit(): void;
    onPointerUp(): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onLongPress(): void;
    private startDraggingHandle;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private cancel;
}
//# sourceMappingURL=PointingHandle.d.ts.map