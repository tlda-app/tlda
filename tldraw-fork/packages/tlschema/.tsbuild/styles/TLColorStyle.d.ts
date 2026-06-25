import { TLDefaultColor, TLThemeDefaultColors, TLThemes } from './TLTheme';
/**
 * The names of all available shape colors, derived from {@link TLThemeDefaultColors}.
 * Extend {@link TLThemeDefaultColors} to add custom color names.
 *
 * @public
 */
export type TLDefaultColorStyle = {
    [K in keyof TLThemeDefaultColors]: TLThemeDefaultColors[K] extends TLDefaultColor ? K : never;
}[keyof TLThemeDefaultColors] & string;
/**
 * @public
 */
export declare const DefaultColorStyle: import("./StyleProp").EnumStyleProp<TLDefaultColorStyle>;
/**
 * @public
 */
export declare const DefaultLabelColorStyle: import("./StyleProp").EnumStyleProp<TLDefaultColorStyle>;
/**
 * Scan theme definitions and sync color registrations to match.
 * A color entry is any key in `TLThemeColors` whose value is an object
 * (i.e. a {@link TLDefaultColor}), as opposed to utility strings like
 * `background` or `text`.
 *
 * Colors present in themes but not yet registered will be added.
 * Colors currently registered but absent from all themes will be removed.
 *
 * @public
 */
export declare function registerColorsFromThemes(definitions: TLThemes): void;
//# sourceMappingURL=TLColorStyle.d.ts.map