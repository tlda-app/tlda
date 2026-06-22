import { StateNode, TLClickEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class PointingCrop extends StateNode {
    static id: string;
    onCancel(): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onLongPress(info: TLPointerEventInfo): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onDoubleClick(info: TLClickEventInfo): void;
    startDragging(info: TLPointerEventInfo): void;
}
//# sourceMappingURL=PointingCrop.d.ts.map