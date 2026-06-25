import { Box, Editor, TLFrameShape } from '@tldraw/editor';
import { TLCreateTextJsxFromSpansOpts } from '../shared/createTextJsxFromSpans';
export declare function defaultEmptyAs(str: string, dflt: string): string;
export declare function getFrameHeadingSide(editor: Editor, shape: TLFrameShape): 0 | 1 | 2 | 3;
/**
 * Get the frame heading info (size and text) for a frame shape.
 *
 * @param editor The editor instance.
 * @param shape The frame shape.
 * @param opts The text measurement options.
 *
 * @returns The frame heading's size (as a Box) and JSX text spans.
 */
export declare function getFrameHeadingSize(editor: Editor, shape: TLFrameShape, opts: TLCreateTextJsxFromSpansOpts): Box;
export declare function getFrameHeadingOpts(width: number, isSvg: boolean): TLCreateTextJsxFromSpansOpts;
export declare function getFrameHeadingTranslation(shape: TLFrameShape, side: 0 | 1 | 2 | 3, isSvg: boolean): string;
//# sourceMappingURL=frameHelpers.d.ts.map