import { Editor as TTEditor } from '@tiptap/core';
import { Node, Schema } from '@tiptap/pm/model';
import { EditorProviderProps } from '@tiptap/react';
import { TLRichText } from '@tldraw/tlschema';
import { TLFontFace } from '@tldraw/tlschema';
import type { Editor } from '../editor/Editor';
/**
 * This is the TipTap editor! Docs are {@link https://tiptap.dev/docs}.
 *
 * @public
 */
export type TiptapEditor = TTEditor;
/**
 * A TipTap node. See {@link https://tiptap.dev/docs}.
 * @public
 */
export type TiptapNode = Node;
/** @public */
export interface TLTextOptions {
    tipTapConfig?: EditorProviderProps;
    addFontsFromNode?: RichTextFontVisitor;
}
/** @public */
export interface RichTextFontVisitorState {
    readonly family: string;
    readonly weight: string;
    readonly style: string;
}
/** @public */
export type RichTextFontVisitor = (node: TiptapNode, state: RichTextFontVisitorState, addFont: (font: TLFontFace) => void) => RichTextFontVisitorState;
export declare function getTipTapSchema(tipTapConfig: EditorProviderProps): Schema<any, any>;
/** @public */
export declare function getFontsFromRichText(editor: Editor, richText: TLRichText, initialState: RichTextFontVisitorState): TLFontFace[];
//# sourceMappingURL=richText.d.ts.map