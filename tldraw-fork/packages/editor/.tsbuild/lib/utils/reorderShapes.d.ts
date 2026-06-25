import { TLShapeId, TLShapePartial } from '@tldraw/tlschema';
import type { Editor } from '../editor/Editor';
/**
 * Gets the changes for reordering shapes.
 * @param editor - The editor.
 * @param operation - The operation to perform.
 * @param ids - The ids of the shapes to reorder.
 * @param opts - The options.
 * @returns The changes.
 * @public
 */
export declare function getReorderingShapesChanges(editor: Editor, operation: 'toBack' | 'toFront' | 'forward' | 'backward', ids: TLShapeId[], opts?: {
    considerAllShapes?: boolean;
}): TLShapePartial[];
//# sourceMappingURL=reorderShapes.d.ts.map