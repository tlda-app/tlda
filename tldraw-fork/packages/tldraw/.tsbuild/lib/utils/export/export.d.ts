import { Editor, TLImageExportOptions, TLShapeId } from '@tldraw/editor';
export declare function exportToString(editor: Editor, ids: TLShapeId[], format: 'svg' | 'json', opts?: TLImageExportOptions): Promise<string>;
export declare function exportToImagePromiseForClipboard(editor: Editor, ids: TLShapeId[], opts?: TLImageExportOptions): {
    blobPromise: Promise<Blob>;
    mimeType: string;
};
//# sourceMappingURL=export.d.ts.map