import { Mat, StateNode, TLArrowShape, TLHandle, TLLineShape, TLPointerEventInfo, TLShapeId, Vec } from '@tldraw/editor';
export type DraggingHandleInfo = TLPointerEventInfo & {
    shape: TLArrowShape | TLLineShape;
    target: 'handle';
    onInteractionEnd?: string | (() => void);
    isCreating?: boolean;
    creatingMarkId?: string;
};
export declare class DraggingHandle extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    shapeId: TLShapeId;
    initialHandle: TLHandle;
    initialAdjacentHandle: TLHandle | null;
    initialPagePoint: Vec;
    markId: string;
    initialPageTransform: Mat;
    initialPageRotation: number;
    info: DraggingHandleInfo;
    isPrecise: boolean;
    isPreciseId: TLShapeId | null;
    pointingId: TLShapeId | null;
    onEnter(info: DraggingHandleInfo): void;
    private exactTimeout;
    private resetExactTimeout;
    private clearExactTimeout;
    onPointerMove(): void;
    onKeyDown(): void;
    onKeyUp(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(): void;
    onExit(): void;
    private complete;
    private cancel;
    private update;
}
//# sourceMappingURL=DraggingHandle.d.ts.map