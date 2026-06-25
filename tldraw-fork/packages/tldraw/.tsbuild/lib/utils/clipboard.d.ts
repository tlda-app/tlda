import { TLCopyType } from './export/copyAs';
export declare const TLDRAW_CUSTOM_PNG_MIME_TYPE: "web image/vnd.tldraw+png";
export declare function getAdditionalClipboardWriteType(format: TLCopyType): string | null;
export declare function getCanonicalClipboardReadType(mimeType: string): string;
export declare function doesClipboardSupportType(mimeType: string): boolean;
export declare function clipboardWrite(types: Record<string, Promise<Blob>>): Promise<void>;
//# sourceMappingURL=clipboard.d.ts.map