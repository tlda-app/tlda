import { T } from '@tldraw/validate';
import { VecModel } from '../misc/geometry-types';
import { TLRichText } from '../misc/TLRichText';
import { RecordProps } from '../recordsWithProps';
import { TLDefaultColorStyle } from '../styles/TLColorStyle';
import { TLDefaultDashStyle } from '../styles/TLDashStyle';
import { TLDefaultFillStyle } from '../styles/TLFillStyle';
import { TLDefaultFontStyle } from '../styles/TLFontStyle';
import { TLDefaultSizeStyle } from '../styles/TLSizeStyle';
import { TLBaseShape } from './TLBaseShape';
/**
 * Style property for arrow shape kind, determining how the arrow is drawn.
 *
 * Arrows can be drawn as arcs (curved) or elbows (angled with straight segments).
 * This affects the visual appearance and behavior of arrow shapes.
 *
 * @example
 * ```ts
 * // Create an arrow with arc style (curved)
 * const arcArrow: TLArrowShape = {
 *   // ... other properties
 *   props: {
 *     kind: 'arc',
 *     // ... other props
 *   }
 * }
 *
 * // Create an arrow with elbow style (angled)
 * const elbowArrow: TLArrowShape = {
 *   // ... other properties
 *   props: {
 *     kind: 'elbow',
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const ArrowShapeKindStyle: import("..").EnumStyleProp<"arc" | "elbow">;
/**
 * The type representing arrow shape kinds.
 *
 * @public
 */
export type TLArrowShapeKind = T.TypeOf<typeof ArrowShapeKindStyle>;
/**
 * Style property for the arrowhead at the start of an arrow.
 *
 * Defines the visual style of the arrowhead at the beginning of the arrow path.
 * Can be one of several predefined styles or none for no arrowhead.
 *
 * @example
 * ```ts
 * // Arrow with no start arrowhead but triangle end arrowhead
 * const arrow: TLArrowShape = {
 *   // ... other properties
 *   props: {
 *     arrowheadStart: 'none',
 *     arrowheadEnd: 'triangle',
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const ArrowShapeArrowheadStartStyle: import("..").EnumStyleProp<"arrow" | "bar" | "diamond" | "dot" | "inverted" | "none" | "pipe" | "square" | "triangle">;
/**
 * Style property for the arrowhead at the end of an arrow.
 *
 * Defines the visual style of the arrowhead at the end of the arrow path.
 * Defaults to 'arrow' style, giving arrows their characteristic pointed appearance.
 *
 * @example
 * ```ts
 * // Arrow with different start and end arrowheads
 * const doubleArrow: TLArrowShape = {
 *   // ... other properties
 *   props: {
 *     arrowheadStart: 'triangle',
 *     arrowheadEnd: 'diamond',
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const ArrowShapeArrowheadEndStyle: import("..").EnumStyleProp<"arrow" | "bar" | "diamond" | "dot" | "inverted" | "none" | "pipe" | "square" | "triangle">;
/**
 * The type representing arrowhead styles for both start and end of arrows.
 *
 * @public
 */
export type TLArrowShapeArrowheadStyle = T.TypeOf<typeof ArrowShapeArrowheadStartStyle>;
/**
 * Properties specific to arrow shapes.
 *
 * Defines all the configurable aspects of an arrow shape, including visual styling,
 * geometry, text labeling, and positioning. Arrows can connect two points and
 * optionally display text labels.
 *
 * @example
 * ```ts
 * const arrowProps: TLArrowShapeProps = {
 *   kind: 'arc',
 *   labelColor: 'black',
 *   color: 'blue',
 *   fill: 'none',
 *   dash: 'solid',
 *   size: 'm',
 *   arrowheadStart: 'none',
 *   arrowheadEnd: 'arrow',
 *   font: 'draw',
 *   start: { x: 0, y: 0 },
 *   end: { x: 100, y: 100 },
 *   bend: 0.2,
 *   richText: toRichText('Label'),
 *   labelPosition: 0.5,
 *   scale: 1,
 *   elbowMidPoint: 0.5
 * }
 * ```
 *
 * @public
 */
export interface TLArrowShapeProps {
    kind: TLArrowShapeKind;
    labelColor: TLDefaultColorStyle;
    color: TLDefaultColorStyle;
    fill: TLDefaultFillStyle;
    dash: TLDefaultDashStyle;
    size: TLDefaultSizeStyle;
    arrowheadStart: TLArrowShapeArrowheadStyle;
    arrowheadEnd: TLArrowShapeArrowheadStyle;
    font: TLDefaultFontStyle;
    start: VecModel;
    end: VecModel;
    bend: number;
    richText: TLRichText;
    labelPosition: number;
    scale: number;
    elbowMidPoint: number;
}
/**
 * A complete arrow shape record.
 *
 * Combines the base shape interface with arrow-specific properties to create
 * a full arrow shape that can be stored and manipulated in the editor.
 *
 * @example
 * ```ts
 * const arrowShape: TLArrowShape = {
 *   id: 'shape:arrow123',
 *   typeName: 'shape',
 *   type: 'arrow',
 *   x: 100,
 *   y: 200,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:main',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     kind: 'arc',
 *     start: { x: 0, y: 0 },
 *     end: { x: 150, y: 100 },
 *     // ... other props
 *   },
 *   meta: {}
 * }
 * ```
 *
 * @public
 */
export type TLArrowShape = TLBaseShape<'arrow', TLArrowShapeProps>;
/**
 * Validation configuration for arrow shape properties.
 *
 * Defines the validators for each property of an arrow shape, ensuring that
 * arrow shape data is valid and conforms to the expected types and constraints.
 *
 * @example
 * ```ts
 * // The validators ensure proper typing and validation
 * const validator = T.object(arrowShapeProps)
 * const validArrowProps = validator.validate({
 *   kind: 'arc',
 *   start: { x: 0, y: 0 },
 *   end: { x: 100, y: 50 },
 *   // ... other required properties
 * })
 * ```
 *
 * @public
 */
export declare const arrowShapeProps: RecordProps<TLArrowShape>;
/**
 * Migration version identifiers for arrow shape properties.
 *
 * These track the evolution of the arrow shape schema over time, with each
 * version representing a specific change to the arrow shape structure or properties.
 *
 * @example
 * ```ts
 * // Used internally for migration system
 * if (version < arrowShapeVersions.AddLabelColor) {
 *   // Apply label color migration
 * }
 * ```
 *
 * @public
 */
export declare const arrowShapeVersions: {
    readonly AddLabelColor: "com.tldraw.shape.arrow/1";
    readonly AddIsPrecise: "com.tldraw.shape.arrow/2";
    readonly AddLabelPosition: "com.tldraw.shape.arrow/3";
    readonly ExtractBindings: "com.tldraw.shape.arrow/4";
    readonly AddScale: "com.tldraw.shape.arrow/5";
    readonly AddElbow: "com.tldraw.shape.arrow/6";
    readonly AddRichText: "com.tldraw.shape.arrow/7";
    readonly AddRichTextAttrs: "com.tldraw.shape.arrow/8";
};
/**
 * Complete migration sequence for arrow shapes.
 *
 * Defines all the migrations needed to transform arrow shape data from older
 * versions to the current version. Each migration handles a specific schema change,
 * ensuring backward compatibility and smooth data evolution.
 *
 * @public
 */
export declare const arrowShapeMigrations: import("@tldraw/store").MigrationSequence;
//# sourceMappingURL=TLArrowShape.d.ts.map