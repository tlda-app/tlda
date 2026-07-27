import { TLFontFace, TLTheme } from '@tldraw/editor';
/** @public */
export interface TLDefaultFont {
    normal: {
        normal: TLFontFace;
        bold: TLFontFace;
    };
    italic: {
        normal: TLFontFace;
        bold: TLFontFace;
    };
}
/** @public */
export interface TLDefaultFonts {
    tldraw_draw: TLDefaultFont;
    tldraw_sans: TLDefaultFont;
    tldraw_serif: TLDefaultFont;
    tldraw_mono: TLDefaultFont;
}
/** @public */
export declare const DefaultFontFaces: TLDefaultFonts;
/** @public */
export declare const allDefaultFontFaces: TLFontFace[];
/**
 * Get the font faces for a given font style from the theme. For built-in fonts, returns
 * undefined so callers can fall back to the rich-text-aware font scanning. For custom
 * fonts (defined in the theme but not in DefaultFontFaces), returns the faces directly.
 *
 * @internal
 */
export declare function getThemeFontFaces(theme: TLTheme, font: string): TLFontFace[] | undefined;
//# sourceMappingURL=defaultFonts.d.ts.map