import { Editor, TLExternalContentSource, VecLike } from '@tldraw/editor';
/**
 * When the clipboard has plain text that is a valid URL, create a bookmark shape and insert it into
 * the scene
 *
 * @param editor - The editor instance.
 * @param url - The URL to paste.
 * @param point - The point at which to paste the file.
 * @internal
 */
export declare function pasteUrl(editor: Editor, url: string, point?: VecLike, sources?: TLExternalContentSource[], clipboardPasteSource?: 'native-event' | 'clipboard-read'): Promise<void>;
//# sourceMappingURL=pasteUrl.d.ts.map