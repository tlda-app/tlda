import { BoundsSnapPoint, Editor, MatModel, StateNode, TLNoteShape, TLPointerEventInfo, TLShape, TLTickEventInfo, Vec } from '@tldraw/editor';
import { DragAndDropManager } from '../DragAndDropManager';
export type TranslatingInfo = TLPointerEventInfo & {
    target: 'shape';
    isCreating?: boolean;
    creatingMarkId?: string;
    onCreate?(): void;
    onInteractionEnd?: string | (() => void);
};
export declare class Translating extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    info: import("@tldraw/editor").TLBaseEventInfo & {
        type: "pointer";
        name: import("@tldraw/editor").TLPointerEventName;
        point: import("@tldraw/editor").VecLike;
        pointerId: number;
        button: number;
        isPen: boolean;
        isPenDirect?: boolean | undefined;
    } & {
        target: "shape";
        shape: TLShape;
    } & {
        target: "shape";
        isCreating?: boolean | undefined;
        creatingMarkId?: string | undefined;
        onCreate?(): void;
        onInteractionEnd?: string | (() => void) | undefined;
    };
    selectionSnapshot: TranslatingSnapshot;
    snapshot: TranslatingSnapshot;
    markId: string;
    isCloning: boolean;
    isCreating: boolean;
    onCreate(_shape: TLShape | null): void;
    dragAndDropManager: DragAndDropManager;
    onEnter(info: TranslatingInfo): void;
    onExit(): void;
    onTick({ elapsed }: TLTickEventInfo): void;
    onPointerMove(): void;
    onKeyDown(): void;
    onKeyUp(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(): void;
    protected startCloning(): void;
    protected stopCloning(): void;
    reset(): void;
    protected complete(): void;
    private cancel;
    protected handleStart(): void;
    protected handleEnd(): void;
    protected updateShapes(): void;
    protected updateParentTransforms(): void;
}
declare function getTranslatingSnapshot(editor: Editor): {
    averagePagePoint: Vec;
    movingShapes: TLShape[];
    shapeSnapshots: MovingShapeSnapshot[];
    initialPageBounds: import("@tldraw/editor").Box;
    initialSnapPoints: BoundsSnapPoint[];
    noteAdjacentPositions: Vec[] | undefined;
    noteSnapshot: (MovingShapeSnapshot & {
        shape: TLNoteShape;
    }) | undefined;
    noteCenterOffset: Vec | undefined;
};
export type TranslatingSnapshot = ReturnType<typeof getTranslatingSnapshot>;
export interface MovingShapeSnapshot {
    shape: TLShape;
    pagePoint: Vec;
    pageRotation: number;
    parentTransform: MatModel | null;
}
export declare function moveShapesToPoint({ editor, snapshot }: {
    editor: Editor;
    snapshot: TranslatingSnapshot;
}): void;
export {};
//# sourceMappingURL=Translating.d.ts.map