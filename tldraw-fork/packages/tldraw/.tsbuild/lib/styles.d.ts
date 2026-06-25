import { type TLTheme, type TLThemeColors } from '@tldraw/editor';
import { TLUiIconJsx } from './ui/components/primitives/TldrawUiIcon';
/** @public */
export type StyleValuesForUi<T> = readonly {
    readonly value: T;
    readonly icon: string | TLUiIconJsx;
}[];
/**
 * Returns the current list of color style items for the style panel,
 * derived from the theme's color palette. Only palette colors are included;
 * utility colors like `text`, `background`, etc. are excluded.
 *
 * Colors are ordered by their position in {@link @tldraw/tlschema#DefaultColorStyle},
 * followed by any additional theme colors in their object key order.
 *
 * @public
 */
export declare function getColorStyleItems(colors: TLThemeColors): StyleValuesForUi<string>;
/**
 * Returns the current list of font style items for the style panel,
 * derived from the theme's font palette.
 *
 * Fonts are ordered by their position in {@link @tldraw/tlschema#DefaultFontStyle},
 * followed by any additional theme fonts in their object key order.
 *
 * @public
 */
export declare function getFontStyleItems(theme: TLTheme): StyleValuesForUi<string>;
export declare const STYLES: {
    readonly fill: readonly [{
        readonly value: "none";
        readonly icon: "fill-none";
    }, {
        readonly value: "semi";
        readonly icon: "fill-semi";
    }, {
        readonly value: "solid";
        readonly icon: "fill-solid";
    }];
    readonly fillExtra: readonly [{
        readonly value: "pattern";
        readonly icon: "fill-pattern";
    }, {
        readonly value: "lined-fill";
        readonly icon: "fill-lined-fill";
    }, {
        readonly value: "fill";
        readonly icon: "fill-fill";
    }];
    readonly dash: readonly [{
        readonly value: "draw";
        readonly icon: "dash-draw";
    }, {
        readonly value: "dashed";
        readonly icon: "dash-dashed";
    }, {
        readonly value: "dotted";
        readonly icon: "dash-dotted";
    }, {
        readonly value: "solid";
        readonly icon: "dash-solid";
    }];
    readonly size: readonly [{
        readonly value: "s";
        readonly icon: "size-small";
    }, {
        readonly value: "m";
        readonly icon: "size-medium";
    }, {
        readonly value: "l";
        readonly icon: "size-large";
    }, {
        readonly value: "xl";
        readonly icon: "size-extra-large";
    }];
    readonly font: readonly [{
        readonly value: "draw";
        readonly icon: "font-draw";
    }, {
        readonly value: "sans";
        readonly icon: "font-sans";
    }, {
        readonly value: "serif";
        readonly icon: "font-serif";
    }, {
        readonly value: "mono";
        readonly icon: "font-mono";
    }];
    readonly textAlign: readonly [{
        readonly value: "start";
        readonly icon: "text-align-left";
    }, {
        readonly value: "middle";
        readonly icon: "text-align-center";
    }, {
        readonly value: "end";
        readonly icon: "text-align-right";
    }];
    readonly horizontalAlign: readonly [{
        readonly value: "start";
        readonly icon: "horizontal-align-start";
    }, {
        readonly value: "middle";
        readonly icon: "horizontal-align-middle";
    }, {
        readonly value: "end";
        readonly icon: "horizontal-align-end";
    }];
    readonly verticalAlign: readonly [{
        readonly value: "start";
        readonly icon: "vertical-align-start";
    }, {
        readonly value: "middle";
        readonly icon: "vertical-align-middle";
    }, {
        readonly value: "end";
        readonly icon: "vertical-align-end";
    }];
    readonly arrowKind: readonly [{
        readonly value: "arc";
        readonly icon: "arrow-arc";
    }, {
        readonly value: "elbow";
        readonly icon: "arrow-elbow";
    }];
    readonly arrowheadStart: readonly [{
        readonly value: "none";
        readonly icon: "arrowhead-none";
    }, {
        readonly value: "arrow";
        readonly icon: "arrowhead-arrow";
    }, {
        readonly value: "triangle";
        readonly icon: "arrowhead-triangle";
    }, {
        readonly value: "square";
        readonly icon: "arrowhead-square";
    }, {
        readonly value: "dot";
        readonly icon: "arrowhead-dot";
    }, {
        readonly value: "diamond";
        readonly icon: "arrowhead-diamond";
    }, {
        readonly value: "inverted";
        readonly icon: "arrowhead-triangle-inverted";
    }, {
        readonly value: "bar";
        readonly icon: "arrowhead-bar";
    }];
    readonly arrowheadEnd: readonly [{
        readonly value: "none";
        readonly icon: "arrowhead-none";
    }, {
        readonly value: "arrow";
        readonly icon: "arrowhead-arrow";
    }, {
        readonly value: "triangle";
        readonly icon: "arrowhead-triangle";
    }, {
        readonly value: "square";
        readonly icon: "arrowhead-square";
    }, {
        readonly value: "dot";
        readonly icon: "arrowhead-dot";
    }, {
        readonly value: "diamond";
        readonly icon: "arrowhead-diamond";
    }, {
        readonly value: "inverted";
        readonly icon: "arrowhead-triangle-inverted";
    }, {
        readonly value: "bar";
        readonly icon: "arrowhead-bar";
    }];
    readonly spline: readonly [{
        readonly value: "line";
        readonly icon: "spline-line";
    }, {
        readonly value: "cubic";
        readonly icon: "spline-cubic";
    }];
};
//# sourceMappingURL=styles.d.ts.map