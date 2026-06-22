import { Editor, TLImageExportOptions, TLShapeId } from '@tldraw/editor';
/** @public */
export type TLCopyType = 'svg' | 'png' | 'json';
/** @public */
export interface CopyAsOptions extends Omit<TLImageExportOptions, 'format'> {
    /** The format to copy as. */
    format: TLCopyType;
}
/**
 * Copy the given shapes to the clipboard.
 *
 * @param editor - The editor instance.
 * @param ids - The ids of the shapes to copy.
 * @param format - The format to copy as. Defaults to png.
 * @param opts - Options for the copy.
 *
 * @public
 */
export declare function copyAs(editor: Editor, ids: TLShapeId[], opts: CopyAsOptions): Promise<void>;
//# sourceMappingURL=copyAs.d.ts.map