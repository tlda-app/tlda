import { Editor, StateNode, TLNoteShape, TLPointerEventInfo, TLShapeId, Vec } from '@tldraw/editor';
export declare class Pointing extends StateNode {
    static id: string;
    dragged: boolean;
    info: TLPointerEventInfo;
    markId: string;
    shape: TLNoteShape;
    onEnter(): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onPointerUp(): void;
    onInterrupt(): void;
    onLongPress(): void;
    onComplete(): void;
    onCancel(): void;
    private complete;
    private cancel;
}
export declare function getNoteShapeAdjacentPositionOffset(editor: Editor, center: Vec, scale: number, noteWidth: number, noteHeight: number): Vec | undefined;
export declare function createNoteShape(editor: Editor, id: TLShapeId, center: Vec): TLNoteShape | undefined;
//# sourceMappingURL=Pointing.d.ts.map