import { Editor, IndexKey, TLNoteShape, TLShape, Vec } from '@tldraw/editor';
/** @internal */
export declare const CLONE_HANDLE_MARGIN = 0;
/** @internal */
export declare const NOTE_ADJACENT_POSITION_SNAP_RADIUS = 10;
/** @internal */
export interface NoteAdjacentPositionsOpts {
    pagePoint: Vec;
    pageRotation: number;
    growY: number;
    extraHeight: number;
    scale: number;
    noteWidth: number;
    noteHeight: number;
}
/**
 * Get the adjacent positions for a particular note shape.
 *
 * @internal */
export declare function getNoteAdjacentPositions(editor: Editor, opts: NoteAdjacentPositionsOpts): Record<IndexKey, Vec>;
/** @internal */
export interface AvailableNoteAdjacentPositionsOpts {
    rotation: number;
    scale: number;
    extraHeight: number;
    noteWidth: number;
    noteHeight: number;
}
/**
 * Get all of the available note adjacent positions, excluding the selected shapes.
 *
 * @internal */
export declare function getAvailableNoteAdjacentPositions(editor: Editor, opts: AvailableNoteAdjacentPositionsOpts): Vec[];
/** @internal */
export interface NoteShapeForAdjacentPositionOpts {
    shape: TLNoteShape;
    center: Vec;
    pageRotation: number;
    noteWidth: number;
    noteHeight: number;
    forceNew?: boolean;
}
/**
 * For a particular adjacent note position, get the shape in that position or create a new one.
 *
 * @internal */
export declare function getNoteShapeForAdjacentPosition(editor: Editor, opts: NoteShapeForAdjacentPositionOpts): TLShape | undefined;
//# sourceMappingURL=noteHelpers.d.ts.map