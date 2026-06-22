import { TLThemeFont, TLThemeFonts, TLThemes } from './TLTheme';
/**
 * Default font style property used by tldraw shapes for text styling.
 * Controls which typeface is used for text content within shapes.
 *
 * Available values:
 * - `draw` - Hand-drawn, sketchy font style
 * - `sans` - Clean sans-serif font
 * - `serif` - Traditional serif font
 * - `mono` - Monospace font for code-like text
 *
 * @example
 * ```ts
 * import { DefaultFontStyle } from '@tldraw/tlschema'
 *
 * // Use in shape props definition
 * interface MyTextShapeProps {
 *   font: typeof DefaultFontStyle
 *   // other props...
 * }
 *
 * // Create a text shape with monospace font
 * const textShape = {
 *   // ... other properties
 *   props: {
 *     font: 'mono' as const,
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const DefaultFontStyle: import("./StyleProp").EnumStyleProp<"draw" | "mono" | "sans" | "serif">;
/**
 * The names of all available font styles, derived from {@link TLThemeFonts}.
 * Extend {@link TLThemeFonts} to add custom font names.
 *
 * @example
 * ```ts
 * import { TLDefaultFontStyle } from '@tldraw/tlschema'
 *
 * // Valid font style values
 * const drawFont: TLDefaultFontStyle = 'draw'
 * const sansFont: TLDefaultFontStyle = 'sans'
 * const serifFont: TLDefaultFontStyle = 'serif'
 * const monoFont: TLDefaultFontStyle = 'mono'
 *
 * // Use in a function parameter
 * function setTextFont(font: TLDefaultFontStyle) {
 *   // Apply font style to text
 * }
 * ```
 *
 * @public
 */
export type TLDefaultFontStyle = keyof TLThemeFonts & string;
/**
 * Mapping of font style names to their corresponding CSS font-family declarations.
 * These are the actual CSS font families used when rendering text with each font style.
 *
 * @example
 * ```ts
 * import { DefaultFontFamilies, TLDefaultFontStyle } from '@tldraw/tlschema'
 *
 * // Get CSS font family for a font style
 * const fontStyle: TLDefaultFontStyle = 'mono'
 * const cssFamily = DefaultFontFamilies[fontStyle] // "'tldraw_mono', monospace"
 *
 * // Apply to DOM element
 * element.style.fontFamily = DefaultFontFamilies.sans
 * ```
 *
 * @public
 */
export declare const DefaultFontFamilies: {
    draw: string;
    sans: string;
    serif: string;
    mono: string;
};
/** @internal */
export declare function isFontEntry(value: unknown): value is TLThemeFont;
/**
 * Scan theme definitions and sync font registrations to match.
 * A font entry is any key in `TLThemeFonts` whose value is a {@link TLThemeFont}
 * object (i.e. has a `fontFamily` property).
 *
 * Fonts present in themes but not yet registered will be added.
 * Fonts currently registered but absent from all themes will be removed.
 *
 * @public
 */
export declare function registerFontsFromThemes(definitions: TLThemes): void;
//# sourceMappingURL=TLFontStyle.d.ts.map