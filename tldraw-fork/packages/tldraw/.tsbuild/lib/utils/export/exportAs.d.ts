import { Editor, TLExportType, TLImageExportOptions, TLShapeId } from '@tldraw/editor';
/** @public */
export interface ExportAsOptions extends TLImageExportOptions {
    /** {@inheritdoc @tldraw/editor#TLImageExportOptions.format} */
    format: TLExportType;
    /** Name of the exported file. If undefined a predefined name, based on the selection, will be used. */
    name?: string;
}
/**
 * Export the given shapes as files.
 *
 * @param editor - The editor instance.
 * @param ids - The ids of the shapes to export.
 * @param opts - Options for the export.
 *
 * @public
 */
export declare function exportAs(editor: Editor, ids: TLShapeId[], opts: ExportAsOptions): Promise<void>;
/** @internal */
export declare function downloadFile(file: File, doc?: Document): void;
//# sourceMappingURL=exportAs.d.ts.map