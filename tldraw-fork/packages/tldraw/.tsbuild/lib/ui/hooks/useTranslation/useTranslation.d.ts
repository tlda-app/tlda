import * as React from 'react';
import { TLUiTranslationKey } from './TLUiTranslationKey';
import { TLUiTranslation } from './translations';
/** @public */
export interface TLUiTranslationProviderProps {
    children: React.ReactNode;
    locale: string;
    /**
     * A collection of overrides different locales.
     *
     * @example
     *
     * ```ts
     * <TranslationProvider overrides={{ en: { 'style-panel.styles': 'Properties' } }} />
     * ```
     */
    overrides?: Record<string, Record<string, string>>;
}
/** @public */
export type TLUiTranslationContextType = TLUiTranslation;
/** @internal */
export declare const TranslationsContext: React.Context<TLUiTranslation | null>;
/** @public */
export declare function useCurrentTranslation(): TLUiTranslation;
/**
 * Provides a translation context to the editor. Wrap this around components that use
 * `useTranslation` (such as `TldrawSelectionForeground`) when you don't want to use the
 * full `TldrawUiContextProvider`. Must be rendered inside an `AssetUrlsProvider`.
 *
 * @public @react
 */
export declare function TldrawUiTranslationProvider({ overrides, locale, children }: TLUiTranslationProviderProps): import("react/jsx-runtime").JSX.Element;
/**
 * Returns a function to translate a translation key into a string based on the current translation.
 *
 * @example
 *
 * ```ts
 * const msg = useTranslation()
 * const label = msg('style-panel.styles')
 * ```
 *
 * @public
 */
export declare function useTranslation(): (id?: string | undefined) => string;
/**
 * Returns the current text direction ('ltr' or 'rtl') based on the current translation.
 *
 * @public
 */
export declare function useDirection(): "ltr" | "rtl";
export declare function untranslated(string: string): TLUiTranslationKey;
//# sourceMappingURL=useTranslation.d.ts.map