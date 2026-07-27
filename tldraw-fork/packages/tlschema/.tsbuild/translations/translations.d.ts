import { LANGUAGES } from './languages';
/** @public */
export { LANGUAGES };
/**
 * A language definition object representing a supported localization in tldraw.
 *
 * Derived from the LANGUAGES array, this type represents a single language entry
 * containing a locale identifier and human-readable label. The locale follows
 * BCP 47 standards (e.g., 'en', 'fr', 'zh-CN') and the label is in the native language.
 *
 * @example
 * ```ts
 * import { TLLanguage } from '@tldraw/tlschema'
 *
 * // Using TLLanguage type
 * const currentLanguage: TLLanguage = { locale: 'fr', label: 'Français' }
 *
 * // Access locale and label
 * console.log(currentLanguage.locale) // "fr"
 * console.log(currentLanguage.label)  // "Français"
 * ```
 *
 * @public
 */
export type TLLanguage = (typeof LANGUAGES)[number];
/**
 * Gets the default translation locale based on the user's browser language preferences.
 *
 * This function determines the best matching locale from the user's browser language
 * settings, falling back to English if no suitable match is found. It works in both
 * browser and server-side environments, defaulting to English on the server.
 *
 * The function prioritizes exact matches first, then falls back to language-only
 * matches, and finally uses predefined regional defaults for languages like Chinese,
 * Portuguese, Korean, and Hindi.
 *
 * @returns The locale identifier (e.g., 'en', 'fr', 'zh-cn') that best matches the user's preferences
 *
 * @example
 * ```ts
 * import { getDefaultTranslationLocale } from '@tldraw/tlschema'
 *
 * // Get the user's preferred locale
 * const locale = getDefaultTranslationLocale()
 * console.log(locale) // e.g., "fr" or "en" or "zh-cn"
 *
 * // Use in localization setup
 * const i18n = new I18n({
 *   locale,
 *   // ... other config
 * })
 * ```
 *
 * @example
 * ```ts
 * // Browser with languages: ['fr-CA', 'en-US']
 * const locale = getDefaultTranslationLocale()
 * console.log(locale) // "fr" (if French is supported)
 *
 * // Browser with languages: ['zh']
 * const locale = getDefaultTranslationLocale()
 * console.log(locale) // "zh-cn" (default region for Chinese)
 * ```
 *
 * @public
 */
export declare function getDefaultTranslationLocale(): TLLanguage['locale'];
/**
 * Internal function that determines the default translation locale from a list of locale preferences.
 *
 * This function is the core logic for locale resolution, separated from browser-specific code
 * for easier testing and reuse. It iterates through the provided locales in priority order
 * and returns the first supported locale found, or 'en' as the ultimate fallback.
 *
 * @param locales - Array of locale identifiers in preference order (e.g., from navigator.languages)
 * @returns The best matching supported locale identifier
 *
 * @example
 * ```ts
 *
 * // Test locale resolution
 * const locale = _getDefaultTranslationLocale(['fr-CA', 'en-US', 'es'])
 * console.log(locale) // "fr" (if French is supported)
 *
 * // No supported locales
 * const fallback = _getDefaultTranslationLocale(['xx-YY', 'zz-AA'])
 * console.log(fallback) // "en"
 * ```
 *
 * @internal
 */
export declare function _getDefaultTranslationLocale(locales: readonly string[]): TLLanguage['locale'];
//# sourceMappingURL=translations.d.ts.map