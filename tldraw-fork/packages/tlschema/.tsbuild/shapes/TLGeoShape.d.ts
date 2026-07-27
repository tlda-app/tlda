import { T } from '@tldraw/validate';
import { TLRichText } from '../misc/TLRichText';
import { RecordProps } from '../recordsWithProps';
import { TLDefaultColorStyle } from '../styles/TLColorStyle';
import { TLDefaultDashStyle } from '../styles/TLDashStyle';
import { TLDefaultFillStyle } from '../styles/TLFillStyle';
import { TLDefaultFontStyle } from '../styles/TLFontStyle';
import { TLDefaultHorizontalAlignStyle } from '../styles/TLHorizontalAlignStyle';
import { TLDefaultSizeStyle } from '../styles/TLSizeStyle';
import { TLDefaultVerticalAlignStyle } from '../styles/TLVerticalAlignStyle';
import { TLBaseShape } from './TLBaseShape';
/**
 * Style property defining the geometric shape type for geo shapes.
 * Provides a variety of built-in geometric forms including basic shapes,
 * polygons, arrows, and special shapes.
 *
 * @public
 * @example
 * ```ts
 * // Use in shape props
 * const props = {
 *   geo: 'rectangle', // or 'ellipse', 'triangle', etc.
 *   // other properties...
 * }
 * ```
 */
export declare const GeoShapeGeoStyle: import("..").EnumStyleProp<"arrow-down" | "arrow-left" | "arrow-right" | "arrow-up" | "check-box" | "cloud" | "diamond" | "ellipse" | "heart" | "hexagon" | "octagon" | "oval" | "pentagon" | "rectangle" | "rhombus" | "rhombus-2" | "star" | "trapezoid" | "triangle" | "x-box">;
/**
 * Type representing valid geometric shape styles for geo shapes.
 *
 * @public
 */
export type TLGeoShapeGeoStyle = T.TypeOf<typeof GeoShapeGeoStyle>;
/**
 * Properties for the geo shape, which renders various geometric forms with styling and text.
 *
 * @public
 */
export interface TLGeoShapeProps {
    /** Geometric shape type (rectangle, ellipse, triangle, etc.) */
    geo: TLGeoShapeGeoStyle;
    /** Dash pattern style for the shape outline */
    dash: TLDefaultDashStyle;
    /** URL link associated with the shape */
    url: string;
    /** Width of the shape in pixels */
    w: number;
    /** Height of the shape in pixels */
    h: number;
    /** Additional vertical growth for text content */
    growY: number;
    /** Scale factor applied to the shape */
    scale: number;
    /** Color style for text label */
    labelColor: TLDefaultColorStyle;
    /** Color style for the shape outline */
    color: TLDefaultColorStyle;
    /** Fill style for the shape interior */
    fill: TLDefaultFillStyle;
    /** Size/thickness style for outline and text */
    size: TLDefaultSizeStyle;
    /** Font style for text content */
    font: TLDefaultFontStyle;
    /** Horizontal alignment for text content */
    align: TLDefaultHorizontalAlignStyle;
    /** Vertical alignment for text content */
    verticalAlign: TLDefaultVerticalAlignStyle;
    /** Rich text content displayed within the shape */
    richText: TLRichText;
}
/**
 * A geo shape represents geometric forms like rectangles, ellipses, triangles, and other
 * predefined shapes. Geo shapes support styling, text content, and can act as containers.
 *
 * @public
 * @example
 * ```ts
 * const geoShape: TLGeoShape = {
 *   id: createShapeId(),
 *   typeName: 'shape',
 *   type: 'geo',
 *   x: 100,
 *   y: 100,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:page1',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     geo: 'rectangle',
 *     w: 200,
 *     h: 100,
 *     color: 'black',
 *     fill: 'solid',
 *     dash: 'solid',
 *     size: 'm',
 *     font: 'draw',
 *     align: 'middle',
 *     verticalAlign: 'middle',
 *     richText: toRichText('Hello World'),
 *     labelColor: 'black',
 *     url: '',
 *     growY: 0,
 *     scale: 1
 *   },
 *   meta: {}
 * }
 * ```
 */
export type TLGeoShape = TLBaseShape<'geo', TLGeoShapeProps>;
/**
 * Validation schema for geo shape properties.
 *
 * @public
 * @example
 * ```ts
 * // Validate geo shape properties
 * const isValidGeo = geoShapeProps.geo.isValid('rectangle')
 * const isValidSize = geoShapeProps.w.isValid(100)
 * const isValidText = geoShapeProps.richText.isValid(toRichText('Hello'))
 * ```
 */
export declare const geoShapeProps: RecordProps<TLGeoShape>;
declare const geoShapeVersions: {
    readonly AddUrlProp: "com.tldraw.shape.geo/1";
    readonly AddLabelColor: "com.tldraw.shape.geo/2";
    readonly RemoveJustify: "com.tldraw.shape.geo/3";
    readonly AddCheckBox: "com.tldraw.shape.geo/4";
    readonly AddVerticalAlign: "com.tldraw.shape.geo/5";
    readonly MigrateLegacyAlign: "com.tldraw.shape.geo/6";
    readonly AddCloud: "com.tldraw.shape.geo/7";
    readonly MakeUrlsValid: "com.tldraw.shape.geo/8";
    readonly AddScale: "com.tldraw.shape.geo/9";
    readonly AddRichText: "com.tldraw.shape.geo/10";
    readonly AddRichTextAttrs: "com.tldraw.shape.geo/11";
};
/**
 * Version identifiers for geo shape migrations.
 *
 * @public
 */
export { geoShapeVersions };
/**
 * Migration sequence for geo shape properties across different schema versions.
 * Handles evolution of geo shapes including URL support, label colors, alignment changes,
 * the transition from plain text to rich text, and support for attrs property on richText.
 *
 * @public
 */
export declare const geoShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLGeoShape.d.ts.map