import { Extension, Extensions } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { Editor, RichTextFontVisitorState, TLFontFace, TLRichText } from '@tldraw/editor';
/** @public */
export declare const KeyboardShiftEnterTweakExtension: Extension<any, any>;
/**
 * Default extensions for the TipTap editor.
 *
 * @public
 */
export declare const tipTapDefaultExtensions: Extensions;
/**
 * Renders HTML from a rich text string.
 *
 * @param editor - The editor instance.
 * @param richText - The rich text content.
 *
 * @public
 */
export declare function renderHtmlFromRichText(editor: Editor, richText: TLRichText): string;
/**
 * Renders HTML from a rich text string for measurement.
 * @param editor - The editor instance.
 * @param richText - The rich text content.
 *
 * @public
 */
export declare function renderHtmlFromRichTextForMeasurement(editor: Editor, richText: TLRichText): string;
export declare function isEmptyRichText(richText: TLRichText): boolean;
/**
 * Whether the editor's active rich text selection is inside a bullet or ordered list.
 * @internal
 */
export declare function isEditingRichTextList(editor: Editor): boolean;
/**
 * Renders plaintext from a rich text string.
 * @param editor - The editor instance.
 * @param richText - The rich text content.
 *
 * @public
 */
export declare function renderPlaintextFromRichText(editor: Editor, richText: TLRichText): string;
/**
 * Renders JSONContent from html.
 * @param editor - The editor instance.
 * @param richText - The rich text content.
 *
 * @public
 */
export declare function renderRichTextFromHTML(editor: Editor, html: string): TLRichText;
/** @public */
export declare function defaultAddFontsFromNode(node: Node, state: RichTextFontVisitorState, addFont: (font: TLFontFace) => void): RichTextFontVisitorState;
//# sourceMappingURL=richText.d.ts.map