import { TLUiAssetUrls } from '../../assetUrls';
import { TLUiTranslationKey } from './TLUiTranslationKey';
/** @public */
export declare const RTL_LANGUAGES: Set<string>;
/** @public */
export interface TLUiTranslation {
    readonly locale: string;
    readonly label: string;
    readonly messages: Record<TLUiTranslationKey, string>;
    readonly dir: 'rtl' | 'ltr';
}
/** @internal */
export declare function fetchTranslation(locale: TLUiTranslation['locale'], assetUrls: TLUiAssetUrls): Promise<TLUiTranslation>;
//# sourceMappingURL=translations.d.ts.map