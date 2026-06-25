import { TLShapeId } from '@tldraw/tlschema';
import type { Editor, TLRenderingShape } from '../editor/Editor';
import { TLImageExportOptions } from '../editor/types/misc-types';
import { Box } from '../primitives/Box';
import { ExportDelay } from './ExportDelay';
export declare function getSvgJsx(editor: Editor, ids: TLShapeId[], opts?: TLImageExportOptions): {
    exportDelay: ExportDelay;
    height: number;
    jsx: import("react/jsx-runtime").JSX.Element;
    trimPadding: number;
    width: number;
} | undefined;
/**
 * Calculates the default bounds for an SVG export. This function handles:
 * 1. Computing masked page bounds for each shape
 * 2. Container logic: if a shape is marked as an export bounds container and it
 *    contains all other shapes, use its bounds and skip padding
 * 3. Otherwise, create a union of all shape bounds and apply padding
 *
 * The container logic is useful for cases like annotating on an image - if the image
 * contains all annotations, we want to export exactly the image bounds without extra padding.
 *
 * @param editor - The editor instance
 * @param renderingShapes - The shapes to include in the export
 * @param padding - Padding to add around the bounds (only applied if no container bounds)
 * @param singleFrameShapeId - If exporting a single frame, this is its ID (skips padding)
 * @returns The calculated bounds box, or null if no shapes to export
 */
export declare function getExportDefaultBounds(editor: Editor, renderingShapes: TLRenderingShape[], padding: number, singleFrameShapeId: null | TLShapeId): {
    box: Box;
    paddingApplied: boolean;
} | {
    box: null;
    paddingApplied: false;
};
//# sourceMappingURL=getSvgJsx.d.ts.map