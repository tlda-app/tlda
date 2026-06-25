import { Editor, IndexKey, TLParentId, TLShape, TLShapeId, Vec } from '@tldraw/editor';
/** @public */
export declare class DragAndDropManager {
    editor: Editor;
    constructor(editor: Editor);
    shapesToActuallyMove: TLShape[];
    draggedOverShapeIds: Set<TLShapeId>;
    initialGroupIds: Map<TLShapeId, TLShapeId>;
    initialParentIds: Map<TLShapeId, TLParentId>;
    initialIndices: Map<TLShapeId, IndexKey>;
    initialDraggingOverShape?: TLShape;
    prevDraggingOverShape?: TLShape;
    prevPagePoint: Vec;
    intervalTimerId: number;
    startDraggingShapes(movingShapes: TLShape[], point: Vec, cb: () => void): void;
    dropShapes(shapes: TLShape[]): void;
    clear(): void;
    dispose(): void;
    private updateDraggingShapes;
}
//# sourceMappingURL=DragAndDropManager.d.ts.map