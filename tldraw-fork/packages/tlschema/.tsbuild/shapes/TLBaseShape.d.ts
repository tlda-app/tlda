import { IndexKey, JsonObject } from '@tldraw/utils';
import { T } from '@tldraw/validate';
import { TLOpacityType } from '../misc/TLOpacity';
import { TLParentId, TLShapeId } from '../records/TLShape';
/**
 * Base interface for all shapes in tldraw.
 *
 * This interface defines the common properties that all shapes share, regardless of their
 * specific type. Every default shape extends this base with additional type-specific properties.
 *
 * Custom shapes should be defined by augmenting the TLGlobalShapePropsMap type and getting the shape type from the TLShape type.
 *
 * @example
 * ```ts
 * // Define a default shape type
 * interface TLArrowShape extends TLBaseShape<'arrow', {
 *   kind: TLArrowShapeKind
 *   labelColor: TLDefaultColorStyle
 *   color: TLDefaultColorStyle
 *   fill: TLDefaultFillStyle
 *   dash: TLDefaultDashStyle
 *   size: TLDefaultSizeStyle
 *   arrowheadStart: TLArrowShapeArrowheadStyle
 *   arrowheadEnd: TLArrowShapeArrowheadStyle
 *   font: TLDefaultFontStyle
 *   start: VecModel
 *   end: VecModel
 *   bend: number
 *   richText: TLRichText
 *   labelPosition: number
 *   scale: number
 *   elbowMidPoint: number
 * }> {}
 *
 * // Create a shape instance
 * const arrowShape: TLArrowShape = {
 *   id: 'shape:abc123',
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
 *     end: { x: 100, y: 100 },
 *     // ... other props
 *   },
 *   meta: {}
 * }
 * ```
 *
 * @public
 */
export interface TLBaseShape<Type extends string, Props extends object> {
    readonly id: TLShapeId;
    readonly typeName: 'shape';
    type: Type;
    x: number;
    y: number;
    rotation: number;
    index: IndexKey;
    parentId: TLParentId;
    isLocked: boolean;
    opacity: TLOpacityType;
    props: Props;
    meta: JsonObject;
}
/**
 * Validator for parent IDs, ensuring they follow the correct format.
 *
 * Parent IDs must start with either "page:" (for shapes directly on a page)
 * or "shape:" (for shapes inside other shapes like frames or groups).
 *
 * @example
 * ```ts
 * // Valid parent IDs
 * const pageParent = parentIdValidator.validate('page:main') // ✓
 * const shapeParent = parentIdValidator.validate('shape:frame1') // ✓
 *
 * // Invalid parent ID (throws error)
 * const invalid = parentIdValidator.validate('invalid:123') // ✗
 * ```
 *
 * @public
 */
export declare const parentIdValidator: T.Validator<TLParentId>;
/**
 * Validator for shape IDs, ensuring they follow the "shape:" format.
 *
 * @example
 * ```ts
 * const validId = shapeIdValidator.validate('shape:abc123') // ✓
 * const invalidId = shapeIdValidator.validate('page:abc123') // ✗ throws error
 * ```
 *
 * @public
 */
export declare const shapeIdValidator: T.Validator<TLShapeId>;
/**
 * Creates a validator for a specific shape type.
 *
 * This function generates a complete validator that can validate shape records
 * of the specified type, including both the base shape properties and any
 * custom properties and metadata specific to that shape type.
 *
 * @param type - The string literal type for this shape (e.g., 'geo', 'arrow')
 * @param props - Optional validator configuration for shape-specific properties
 * @param meta - Optional validator configuration for shape-specific metadata
 * @returns A validator that can validate complete shape records of the specified type
 *
 * @example
 * ```ts
 * // Create a validator for a custom shape type
 * const customShapeValidator = createShapeValidator('custom', {
 *   width: T.number,
 *   height: T.number,
 *   color: T.string
 * })
 *
 * // Use the validator to validate shape data
 * const shapeData = {
 *   id: 'shape:abc123',
 *   typeName: 'shape',
 *   type: 'custom',
 *   x: 100,
 *   y: 200,
 *   // ... other base properties
 *   props: {
 *     width: 150,
 *     height: 100,
 *     color: 'red'
 *   }
 * }
 *
 * const validatedShape = customShapeValidator.validate(shapeData)
 * ```
 *
 * @public
 */
export declare function createShapeValidator<Type extends string, Props extends JsonObject, Meta extends JsonObject>(type: Type, props?: {
    [K in keyof Props]: T.Validatable<Props[K]>;
}, meta?: {
    [K in keyof Meta]: T.Validatable<Meta[K]>;
}): T.ObjectValidator<import("@tldraw/utils").Expand<{ [P in "id" | "index" | "isLocked" | "meta" | "opacity" | "parentId" | "rotation" | "typeName" | "x" | "y" | (undefined extends Props ? never : "props") | (undefined extends Type ? never : "type")]: TLBaseShape<Type, Props>[P]; } & { [P in (undefined extends Props ? "props" : never) | (undefined extends Type ? "type" : never)]?: TLBaseShape<Type, Props>[P] | undefined; }>>;
//# sourceMappingURL=TLBaseShape.d.ts.map