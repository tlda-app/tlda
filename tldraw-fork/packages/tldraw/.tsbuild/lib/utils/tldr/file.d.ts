import { Editor, MigrationFailureReason, Result, SerializedSchema, TLSchema, TLStore, UnknownRecord } from '@tldraw/editor';
import { TLUiToastsContextType } from '../../ui/context/toasts';
import { TLUiTranslationKey } from '../../ui/hooks/useTranslation/TLUiTranslationKey';
/** @public */
export declare const TLDRAW_FILE_MIMETYPE: "application/vnd.tldraw+json";
/** @public */
export declare const TLDRAW_FILE_EXTENSION: ".tldr";
/** @public */
export interface TldrawFile {
    tldrawFileFormatVersion: number;
    schema: SerializedSchema;
    records: UnknownRecord[];
}
/** @public */
export declare function isV1File(data: any): boolean;
/** @public */
export type TldrawFileParseError = {
    type: 'v1File';
    data: any;
} | {
    type: 'notATldrawFile';
    cause: unknown;
} | {
    type: 'fileFormatVersionTooNew';
    version: number;
} | {
    type: 'migrationFailed';
    reason: MigrationFailureReason;
} | {
    type: 'invalidRecords';
    cause: unknown;
};
/** @public */
export declare function parseTldrawJsonFile({ json, schema }: {
    schema: TLSchema;
    json: string;
}): Result<TLStore, TldrawFileParseError>;
/** @public */
export declare function serializeTldrawJson(editor: Editor): Promise<string>;
/** @public */
export declare function serializeTldrawJsonBlob(editor: Editor): Promise<Blob>;
/** @internal */
export declare function parseAndLoadDocument(editor: Editor, document: string, msg: (id: TLUiTranslationKey | Exclude<string, TLUiTranslationKey>) => string, addToast: TLUiToastsContextType['addToast'], onV1FileLoad?: () => void, forceDarkMode?: boolean): Promise<void>;
//# sourceMappingURL=file.d.ts.map