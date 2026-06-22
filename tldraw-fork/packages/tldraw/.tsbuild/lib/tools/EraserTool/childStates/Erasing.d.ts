import { StateNode, TLPointerEventInfo, TLShapeId } from '@tldraw/editor';
export declare class Erasing extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    private info;
    private scribbleId;
    private markId;
    private excludedShapeIds;
    _erasingShapeIds: TLShapeId[];
    onEnter(info: TLPointerEventInfo): void;
    private pushPointToScribble;
    onExit(): void;
    onPointerMove(): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    update(): void;
    complete(info?: TLPointerEventInfo): void;
    cancel(): void;
}
//# sourceMappingURL=Erasing.d.ts.map