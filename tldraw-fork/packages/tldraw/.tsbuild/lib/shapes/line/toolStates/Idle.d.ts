import { StateNode, TLShapeId } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    private shapeId;
    onEnter(info: {
        shapeId: TLShapeId;
    }): void;
    onPointerDown(): void;
    onCancel(): void;
}
//# sourceMappingURL=Idle.d.ts.map