import { LANGUAGES, RecursivePartial } from '@tldraw/editor';
import { DEFAULT_EMBED_DEFINITIONS } from '../defaultEmbedDefinitions';
import { TLEditorAssetUrls } from '../utils/static-assets/assetUrls';
import { TLUiIconType } from './icon-types';
/** @public */
export interface TLUiAssetUrls extends TLEditorAssetUrls {
    icons: Record<TLUiIconType | Exclude<string, TLUiIconType>, string>;
    translations: Record<(typeof LANGUAGES)[number]['locale'], string>;
    embedIcons: Partial<Record<(typeof DEFAULT_EMBED_DEFINITIONS)[number]['type'], string>>;
}
/** @public */
export type TLUiAssetUrlOverrides = RecursivePartial<TLUiAssetUrls>;
export declare let defaultUiAssetUrls: TLUiAssetUrls;
/** @internal */
export declare function setDefaultUiAssetUrls(urls: TLUiAssetUrls): void;
/** @internal */
export declare function useDefaultUiAssetUrlsWithOverrides(overrides?: TLUiAssetUrlOverrides): TLUiAssetUrls;
//# sourceMappingURL=assetUrls.d.ts.map