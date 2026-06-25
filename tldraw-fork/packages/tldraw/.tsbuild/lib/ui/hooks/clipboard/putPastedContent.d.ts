import { Editor, TLExternalContent, VecLike } from '@tldraw/editor';
/** @internal */
export interface PutPastedExternalContentMeta {
    source: 'native-event' | 'clipboard-read';
    point?: VecLike;
}
/** @internal */
export declare function putPastedExternalContent(editor: Editor, content: TLExternalContent<unknown>, meta: PutPastedExternalContentMeta): Promise<void>;
//# sourceMappingURL=putPastedContent.d.ts.map