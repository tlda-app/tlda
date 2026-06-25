import { StateNode, TLShapeId } from '@tldraw/editor';
export declare class ScribbleBrushing extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    hits: Set<TLShapeId>;
    size: number;
    scribbleId: string;
    initialSelectedShapeIds: Set<TLShapeId>;
    newlySelectedShapeIds: Set<TLShapeId>;
    onEnter(): void;
    onExit(): void;
    onPointerMove(): void;
    onPointerUp(): void;
    onKeyDown(): void;
    onKeyUp(): void;
    onCancel(): void;
    onComplete(): void;
    private pushPointToScribble;
    private updateScribbleSelection;
    private complete;
    private cancel;
}
//# sourceMappingURL=ScribbleBrushing.d.ts.map