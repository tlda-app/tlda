import { T } from '@tldraw/validate';
/**
 * Default dash style property used by tldraw shapes for line styling.
 * Controls how shape outlines and lines are rendered with different dash patterns.
 *
 * Available values:
 * - `draw` - Hand-drawn, sketchy line style
 * - `solid` - Continuous solid line
 * - `dashed` - Evenly spaced dashes
 * - `dotted` - Evenly spaced dots
 *
 * @example
 * ```ts
 * import { DefaultDashStyle } from '@tldraw/tlschema'
 *
 * // Use in shape props definition
 * interface MyShapeProps {
 *   dash: typeof DefaultDashStyle
 *   // other props...
 * }
 *
 * // Create a shape with dashed outline
 * const shape = {
 *   // ... other properties
 *   props: {
 *     dash: 'dashed' as const,
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const DefaultDashStyle: import("./StyleProp").EnumStyleProp<"dashed" | "dotted" | "draw" | "none" | "solid">;
/**
 * Type representing a default dash style value.
 * This is a union type of all available dash style options.
 *
 * @example
 * ```ts
 * import { TLDefaultDashStyle } from '@tldraw/tlschema'
 *
 * // Valid dash style values
 * const drawStyle: TLDefaultDashStyle = 'draw'
 * const solidStyle: TLDefaultDashStyle = 'solid'
 * const dashedStyle: TLDefaultDashStyle = 'dashed'
 * const dottedStyle: TLDefaultDashStyle = 'dotted'
 *
 * // Use in a function parameter
 * function setShapeDash(dash: TLDefaultDashStyle) {
 *   // Apply dash style to shape
 * }
 * ```
 *
 * @public
 */
export type TLDefaultDashStyle = T.TypeOf<typeof DefaultDashStyle>;
//# sourceMappingURL=TLDashStyle.d.ts.map