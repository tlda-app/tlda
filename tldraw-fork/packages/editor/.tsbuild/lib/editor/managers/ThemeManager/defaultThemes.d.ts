import { TLDefaultColor, TLDefaultColorStyle, TLTheme, TLThemeColors } from '@tldraw/tlschema';
/**
 * The default theme definition containing color palettes for both light and dark modes.
 *
 * @public
 */
export declare const DEFAULT_THEME: TLTheme;
/**
 * Resolves a color style value to its actual CSS color string for a given theme and variant.
 * If the color is not a default theme color, returns the color value as-is.
 *
 * @param colors - The color palette for the current color mode (e.g. `theme.colors[colorMode]`)
 * @param color - The color style value to resolve
 * @param variant - Which variant of the color to return (solid, fill, pattern, etc.)
 * @returns The CSS color string for the specified color and variant
 *
 * @example
 * ```ts
 * import { getColorValue } from 'tldraw'
 *
 * const colors = editor.getCurrentTheme().colors[editor.getColorMode()]
 *
 * // Get the solid variant of red
 * const redSolid = getColorValue(colors, 'red', 'solid') // '#e03131'
 *
 * // Get the fill variant of blue
 * const blueFill = getColorValue(colors, 'blue', 'fill') // '#4465e9'
 *
 * // Custom color passes through unchanged
 * const customColor = getColorValue(colors, '#ff0000', 'solid') // '#ff0000'
 * ```
 *
 * @public
 */
export declare function getColorValue(colors: TLThemeColors, color: TLDefaultColorStyle | string, variant: keyof TLDefaultColor): string;
//# sourceMappingURL=defaultThemes.d.ts.map