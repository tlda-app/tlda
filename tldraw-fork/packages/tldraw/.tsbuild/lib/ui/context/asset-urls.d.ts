import { TLUiAssetUrls } from '../assetUrls';
/** @public */
export interface AssetUrlsProviderProps {
    assetUrls: TLUiAssetUrls;
    children: React.ReactNode;
}
/**
 * Provides asset URLs (icons, fonts, translations, embed icons) to the editor's UI.
 * Required when using `TldrawUiTranslationProvider` without `TldrawUiContextProvider`.
 *
 * @public @react
 */
export declare function AssetUrlsProvider({ assetUrls, children }: AssetUrlsProviderProps): import("react/jsx-runtime").JSX.Element;
/** @public */
export declare function useAssetUrls(): TLUiAssetUrls;
//# sourceMappingURL=asset-urls.d.ts.map