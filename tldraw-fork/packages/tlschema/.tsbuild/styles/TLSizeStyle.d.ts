import { T } from '@tldraw/validate';
/**
 * Default size style property used by tldraw shapes for scaling visual elements.
 * Controls the relative size of shape elements like stroke width, text size, and other proportional features.
 *
 * Available values:
 * - `s` - Small size
 * - `m` - Medium size (default)
 * - `l` - Large size
 * - `xl` - Extra large size
 *
 * @example
 * ```ts
 * import { DefaultSizeStyle } from '@tldraw/tlschema'
 *
 * // Use in shape props definition
 * interface MyShapeProps {
 *   size: typeof DefaultSizeStyle
 *   // other props...
 * }
 *
 * // Create a shape with large size
 * const shape = {
 *   // ... other properties
 *   props: {
 *     size: 'l' as const,
 *     // ... other props
 *   }
 * }
 * ```
 *
 * @public
 */
export declare const DefaultSizeStyle: import("./StyleProp").EnumStyleProp<"l" | "m" | "s" | "xl">;
/**
 * Type representing a default size style value.
 * This is a union type of all available size options.
 *
 * @example
 * ```ts
 * import { TLDefaultSizeStyle } from '@tldraw/tlschema'
 *
 * // Valid size values
 * const smallSize: TLDefaultSizeStyle = 's'
 * const mediumSize: TLDefaultSizeStyle = 'm'
 * const largeSize: TLDefaultSizeStyle = 'l'
 * const extraLargeSize: TLDefaultSizeStyle = 'xl'
 *
 * // Use in a function parameter
 * function setShapeSize(size: TLDefaultSizeStyle) {
 *   // Apply size style to shape
 * }
 * ```
 *
 * @public
 */
export type TLDefaultSizeStyle = T.TypeOf<typeof DefaultSizeStyle>;
//# sourceMappingURL=TLSizeStyle.d.ts.map