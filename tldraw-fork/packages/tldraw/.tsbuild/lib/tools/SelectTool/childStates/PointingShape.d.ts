import { StateNode, TLClickEventInfo, TLPointerEventInfo, TLShape } from '@tldraw/editor';
export declare class PointingShape extends StateNode {
    static id: string;
    hitShape: TLShape;
    hitShapeForPointerUp: TLShape;
    isDoubleClick: boolean;
    didCtrlOnEnter: boolean;
    didSelectOnEnter: boolean;
    onEnter(info: TLPointerEventInfo & {
        target: 'shape';
    }): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onLongPress(info: TLPointerEventInfo): void;
    private startTranslating;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private cancel;
}
//# sourceMappingURL=PointingShape.d.ts.map