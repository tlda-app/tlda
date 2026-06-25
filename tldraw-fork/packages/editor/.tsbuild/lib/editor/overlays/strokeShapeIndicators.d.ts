import { TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../Editor';
/**
 * Combine every batchable shape indicator into a single page-space `Path2D` and
 * emit one stroke call. Shapes whose indicator needs an evenodd clip (e.g.
 * arrows with labels or complex arrowheads) can't be batched — they still
 * stroke individually inside a save/restore with `ctx.clip` applied.
 *
 * Shared by any overlay util that paints shape indicators (e.g. collaborator
 * selections).
 *
 * @public
 */
export declare function strokeShapeIndicators(editor: Editor, ctx: CanvasRenderingContext2D, shapeIds: TLShapeId[]): void;
//# sourceMappingURL=strokeShapeIndicators.d.ts.map