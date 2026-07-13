/**
 * Resolve the editor that owns a shape referenced by a fleet interaction.
 *
 * HUD fleet shapes live in the clipped panel editor, while empty-canvas drops
 * are created in the main document editor. Filter commits must therefore use
 * the editor that actually contains the target chat shape.
 */
export type FleetShapeLookup = {
  getShape: Editor['getShape']
}

export function editorOwningFleetShape<T extends FleetShapeLookup>(
  preferredEditor: T,
  fallbackEditor: T,
  shapeId: unknown,
): T {
  return preferredEditor.getShape(shapeId as Parameters<Editor['getShape']>[0])
    ? preferredEditor
    : fallbackEditor
}
import type { Editor } from 'tldraw'
