import { StateNode, TLClickEventInfo, TLPointerEventInfo } from '@tldraw/editor';
type TLPointingCropHandleInfo = TLPointerEventInfo & {
    target: 'selection';
} & {
    onInteractionEnd?: string | (() => void);
};
export declare class PointingCropHandle extends StateNode {
    static id: string;
    private info;
    onEnter(info: TLPointingCropHandleInfo): void;
    onExit(): void;
    onPointerMove(): void;
    onLongPress(): void;
    private startCropping;
    onPointerUp(): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private cancel;
}
export {};
//# sourceMappingURL=PointingCropHandle.d.ts.map