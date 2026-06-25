import { TLShape, TLShapeId } from '@tldraw/tlschema';
import { Editor } from '../editor/Editor';
/**
 * Reparents shapes that are no longer contained within their parent shapes.
 *
 * @param editor - The editor instance.
 * @param shapeIds - The IDs of the shapes to reparent.
 * @param opts - Optional options, including a callback to filter out certain parents, such as when removing a frame.
 *
 * @public
 */
export declare function kickoutOccludedShapes(editor: Editor, shapeIds: TLShapeId[], opts?: {
    filter?(parent: TLShape): boolean;
}): void;
/**
 * Get the shapes that will be reparented to new parents when the shapes are dropped.
 *
 * @param editor - The editor instance.
 * @param shapes - The shapes to check.
 * @param cb - A callback to filter out certain shapes.
 * @returns An object with the shapes that will be reparented to new parents and the shapes that will be reparented to the page or their ancestral group.
 *
 * @public
 */
export declare function getDroppedShapesToNewParents(editor: Editor, shapes: Set<TLShape> | TLShape[], cb?: (shape: TLShape, parent: TLShape) => boolean): {
    remainingShapesToReparent: Set<TLShape>;
    reparenting: Map<TLShapeId, TLShape[]>;
};
//# sourceMappingURL=reparenting.d.ts.map