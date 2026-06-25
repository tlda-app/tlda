import { Editor } from '@tldraw/editor';
/**
 * Update the hovered overlay id. This should be called BEFORE updateHoveredShapeId
 * so that overlays take priority over shapes for hover state.
 *
 * @returns true if an overlay is hovered (meaning shape hover should be skipped)
 * @internal
 */
export declare function updateHoveredOverlayId(editor: Editor): boolean;
//# sourceMappingURL=updateHoveredOverlayId.d.ts.map