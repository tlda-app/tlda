import { StateNode, TLArrowShape, TLPointerEventInfo, TLShapeId } from '@tldraw/editor';
export declare class PointingArrowLabel extends StateNode {
    static id: string;
    shapeId: TLShapeId;
    markId: string;
    wasAlreadySelected: boolean;
    didDrag: boolean;
    didCtrlOnEnter: boolean;
    private info;
    private updateCursor;
    onEnter(info: TLPointerEventInfo & {
        shape: TLArrowShape;
        onInteractionEnd?: string | (() => void);
        isCreating: boolean;
    }): void;
    onExit(): void;
    private _labelDragOffset;
    onPointerMove(): void;
    onPointerUp(): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private complete;
    private cancel;
}
//# sourceMappingURL=PointingArrowLabel.d.ts.map