import { T } from '@tldraw/validate';
/**
 * Default fill style property used by tldraw shapes for interior styling.
 * Controls how the inside of shapes are filled or left empty.
 *
 * Available values:
 * - `none` - No fill, shape interior is transparent
 * - `semi` - Semi-transparent fill using the shape's color
 * - `solid` - Solid fill using the shape's color
 * - `pattern` - Crosshatch pattern fill using the shape's color
 * - `fill` - Alternative solid fill variant
 *
 * @example
 * ```ts
 * import { DefaultFillStyle } from '@tldraw/tlschema'
 *
 * // Use in shape props definition
 * interface MyShapeProps {
 *   fill: typeof DefaultFillStyle
 *   // other props...
 * }
 *
 * // Create a shape with solid fill
 * const shape = {
 *   // ... other properties
 *   props: {
 *     fill: 'solid' as const,
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const DefaultFillStyle: import("./StyleProp").EnumStyleProp<"fill" | "lined-fill" | "none" | "pattern" | "semi" | "solid">;
/**
 * Type representing a default fill style value.
 * This is a union type of all available fill style options.
 *
 * @example
 * ```ts
 * import { TLDefaultFillStyle } from '@tldraw/tlschema'
 *
 * // Valid fill style values
 * const noFill: TLDefaultFillStyle = 'none'
 * const solidFill: TLDefaultFillStyle = 'solid'
 * const patternFill: TLDefaultFillStyle = 'pattern'
 *
 * // Use in a function parameter
 * function setShapeFill(fill: TLDefaultFillStyle) {
 *   // Apply fill style to shape
 * }
 * ```
 *
 * @public
 */
export type TLDefaultFillStyle = T.TypeOf<typeof DefaultFillStyle>;
//# sourceMappingURL=TLFillStyle.d.ts.map