import { TLDefaultSizeStyle, TLTheme } from '@tldraw/editor';
/** @internal */
export declare const TEXT_PROPS: {
    fontWeight: string;
    fontVariant: string;
    fontStyle: string;
    padding: string;
};
/** @internal */
export declare const STROKE_SIZES: Record<TLDefaultSizeStyle, number>;
/** @internal */
export declare const FONT_SIZES: Record<TLDefaultSizeStyle, number>;
/** @internal */
export declare const LABEL_FONT_SIZES: Record<TLDefaultSizeStyle, number>;
/** @internal */
export declare const ARROW_LABEL_FONT_SIZES: Record<TLDefaultSizeStyle, number>;
/** @internal */
export declare const FONT_FAMILIES: Record<string, string>;
/** @public */
export declare function getFontFamily(theme: TLTheme, font: string): string;
/** @internal */
export declare const LABEL_TO_ARROW_PADDING = 20;
/** @internal */
export declare const ARROW_LABEL_PADDING = 4.25;
/** @internal */
export declare const LABEL_PADDING = 16;
//# sourceMappingURL=default-shape-constants.d.ts.map