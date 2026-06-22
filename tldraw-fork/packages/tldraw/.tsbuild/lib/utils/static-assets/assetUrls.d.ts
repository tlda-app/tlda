import { RecursivePartial } from '@tldraw/editor';
/** @public */
export interface TLEditorAssetUrls {
    fonts?: {
        tldraw_mono?: string;
        tldraw_mono_italic?: string;
        tldraw_mono_bold?: string;
        tldraw_mono_italic_bold?: string;
        tldraw_serif?: string;
        tldraw_serif_italic?: string;
        tldraw_serif_bold?: string;
        tldraw_serif_italic_bold?: string;
        tldraw_sans?: string;
        tldraw_sans_italic?: string;
        tldraw_sans_bold?: string;
        tldraw_sans_italic_bold?: string;
        tldraw_draw?: string;
        tldraw_draw_italic?: string;
        tldraw_draw_bold?: string;
        tldraw_draw_italic_bold?: string;
        [key: string]: string | undefined;
    };
}
/** @public */
export declare let defaultEditorAssetUrls: TLEditorAssetUrls;
/** @internal */
export declare function setDefaultEditorAssetUrls(assetUrls: TLEditorAssetUrls): void;
/** @internal */
export declare function useDefaultEditorAssetsWithOverrides(overrides?: RecursivePartial<TLEditorAssetUrls>): TLEditorAssetUrls;
//# sourceMappingURL=assetUrls.d.ts.map