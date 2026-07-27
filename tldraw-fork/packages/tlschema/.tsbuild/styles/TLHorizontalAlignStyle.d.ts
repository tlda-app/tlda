import { T } from '@tldraw/validate';
/**
 * Default horizontal alignment style property used by tldraw shapes for text positioning.
 * Controls how text content is horizontally aligned within shape boundaries.
 *
 * Available values:
 * - `start` - Align text to the start (left in LTR, right in RTL)
 * - `middle` - Center text horizontally
 * - `end` - Align text to the end (right in LTR, left in RTL)
 * - `start-legacy` - Legacy start alignment (deprecated)
 * - `end-legacy` - Legacy end alignment (deprecated)
 * - `middle-legacy` - Legacy middle alignment (deprecated)
 *
 * @example
 * ```ts
 * import { DefaultHorizontalAlignStyle } from '@tldraw/tlschema'
 *
 * // Use in shape props definition
 * interface MyTextShapeProps {
 *   align: typeof DefaultHorizontalAlignStyle
 *   // other props...
 * }
 *
 * // Create a shape with center-aligned text
 * const textShape = {
 *   // ... other properties
 *   props: {
 *     align: 'middle' as const,
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const DefaultHorizontalAlignStyle: import("./StyleProp").EnumStyleProp<"end" | "end-legacy" | "middle" | "middle-legacy" | "start" | "start-legacy">;
/**
 * Type representing a default horizontal alignment style value.
 * This is a union type of all available horizontal alignment options.
 *
 * @example
 * ```ts
 * import { TLDefaultHorizontalAlignStyle } from '@tldraw/tlschema'
 *
 * // Valid horizontal alignment values
 * const leftAlign: TLDefaultHorizontalAlignStyle = 'start'
 * const centerAlign: TLDefaultHorizontalAlignStyle = 'middle'
 * const rightAlign: TLDefaultHorizontalAlignStyle = 'end'
 *
 * // Use in a function parameter
 * function setTextAlignment(align: TLDefaultHorizontalAlignStyle) {
 *   // Apply horizontal alignment to text
 * }
 * ```
 *
 * @public
 */
export type TLDefaultHorizontalAlignStyle = T.TypeOf<typeof DefaultHorizontalAlignStyle>;
//# sourceMappingURL=TLHorizontalAlignStyle.d.ts.map