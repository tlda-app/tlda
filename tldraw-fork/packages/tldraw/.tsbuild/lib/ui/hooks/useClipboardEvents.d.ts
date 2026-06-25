import { Editor, TLClipboardWriteInfo, VecLike } from '@tldraw/editor';
import { TLUiEventSource } from '../context/events';
/**
 * Resolves paste modifier keys into plain-text and position behavior.
 * Alt/Option inverts the paste-at-cursor user preference.
 *
 * @param isShift - Whether the Shift key is pressed (indicates plain text paste)
 * @param isAlt - Whether the Alt/Option key is pressed (inverts paste position preference)
 * @param pasteAtCursorPref - The user's preference for pasting at the cursor (true) or center (false)
 *
 * @internal
 */
export declare function resolvePasteModifiers(isShift: boolean, isAlt: boolean, pasteAtCursorPref: boolean): {
    isPlainText: boolean;
    pasteAtCursor: boolean;
};
/**
 * Extract iframe src and dimensions from an HTML string containing an iframe element.
 * Tries width/height HTML attributes first, then falls back to pixel values in the
 * style attribute, then to sensible defaults.
 * Returns null if no valid iframe is found.
 * @internal
 */
export declare function extractIframeFromHtml(html: string): {
    src: string;
    width: number;
    height: number;
} | null;
/** @public */
export declare function isValidHttpURL(url: string): boolean;
export { putPastedExternalContent } from './clipboard/putPastedContent';
/**
 * When the user copies or cuts, write the contents to the clipboard.
 *
 * @public
 */
export declare function handleNativeOrMenuCopy(editor: Editor, context?: TLClipboardWriteInfo): Promise<boolean>;
/** @public */
export declare function useMenuClipboardEvents(): {
    copy: (source: TLUiEventSource) => Promise<void>;
    cut: (source: TLUiEventSource) => Promise<void>;
    paste: (data: ClipboardItem[] | DataTransfer, source: TLUiEventSource, point?: VecLike | undefined) => Promise<void>;
};
/** @public */
export declare function useNativeClipboardEvents(): void;
//# sourceMappingURL=useClipboardEvents.d.ts.map