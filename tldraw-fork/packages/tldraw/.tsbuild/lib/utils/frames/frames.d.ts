import { Editor, TLShape, TLShapeId } from '@tldraw/editor';
/**
 * Remove a frame (or any frame-like container shape).
 *
 * @param editor - tldraw editor instance.
 * @param ids - Ids of the frames you wish to remove.
 *
 * @public
 */
export declare function removeFrame(editor: Editor, ids: TLShapeId[]): void;
/** @internal */
export declare const DEFAULT_FRAME_PADDING = 50;
export declare function getFrameChildrenBounds(children: (TLShape | undefined)[], editor: Editor, opts?: {
    padding: number;
}): {
    w: number;
    h: number;
    dx: number;
    dy: number;
};
/**
 * Fit a frame (or any frame-like container shape) to its content.
 *
 * @param id - Id of the frame you wish to fit to content.
 * @param editor - tlraw editor instance.
 * @param opts - Options for fitting the frame.
 *
 * @public
 */
export declare function fitFrameToContent(editor: Editor, id: TLShapeId, opts?: {
    padding: number;
}): void;
//# sourceMappingURL=frames.d.ts.map