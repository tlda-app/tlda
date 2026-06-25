import { TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../Editor';
import { TLViewport } from '../viewports/TLViewport';
/**
 * Non visible shapes are shapes outside of the viewport page bounds.
 *
 * @param editor - Instance of the tldraw Editor.
 * @returns Incremental derivation of non visible shapes.
 */
export declare function notVisibleShapes(editor: Editor): import("@tldraw/state").Computed<Set<TLShapeId>, unknown>;
/** @public */
export declare function getNotVisibleShapesForViewport(editor: Editor, viewport: TLViewport): Set<TLShapeId>;
//# sourceMappingURL=notVisibleShapes.d.ts.map