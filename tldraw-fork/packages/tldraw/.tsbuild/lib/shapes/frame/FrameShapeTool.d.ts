import { BaseBoxShapeTool, Editor, TLShape, TLShapeId } from '@tldraw/editor';
/** @public */
export declare class FrameShapeTool extends BaseBoxShapeTool {
    static id: string;
    static initial: string;
    shapeType: "frame";
    onCreate(shape: TLShape | null): void;
}
/**
 * Get the ids of the sibling shapes that a frame would enclose at its current page bounds.
 *
 * @internal
 */
export declare function getEnclosedShapeIds(editor: Editor, shape: TLShape): TLShapeId[];
//# sourceMappingURL=FrameShapeTool.d.ts.map