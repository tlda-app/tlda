import { RecordProps } from '../recordsWithProps';
import { TLDefaultColorStyle } from '../styles/TLColorStyle';
import { TLBaseShape } from './TLBaseShape';
/**
 * Properties for the frame shape, which provides a container for organizing other shapes.
 *
 * @public
 */
export interface TLFrameShapeProps {
    /** Width of the frame in pixels */
    w: number;
    /** Height of the frame in pixels */
    h: number;
    /** Display name for the frame (shown in UI) */
    name: string;
    /** Color style for the frame border and label */
    color: TLDefaultColorStyle;
}
/**
 * A frame shape provides a container for organizing and grouping other shapes.
 * Frames can be used to create sections, organize content, or define specific areas.
 *
 * @public
 * @example
 * ```ts
 * const frameShape: TLFrameShape = {
 *   id: createShapeId(),
 *   typeName: 'shape',
 *   type: 'frame',
 *   x: 0,
 *   y: 0,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:page1',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     w: 400,
 *     h: 300,
 *     name: 'Header Section',
 *     color: 'blue'
 *   },
 *   meta: {}
 * }
 * ```
 */
export type TLFrameShape = TLBaseShape<'frame', TLFrameShapeProps>;
/**
 * Validation schema for frame shape properties.
 *
 * @public
 * @example
 * ```ts
 * // Validate frame properties
 * const isValidName = frameShapeProps.name.isValid('My Frame')
 * const isValidColor = frameShapeProps.color.isValid('red')
 * ```
 */
export declare const frameShapeProps: RecordProps<TLFrameShape>;
declare const Versions: {
    readonly AddColorProp: "com.tldraw.shape.frame/1";
};
/**
 * Version identifiers for frame shape migrations.
 *
 * @public
 */
export { Versions as frameShapeVersions };
/**
 * Migration sequence for frame shape properties across different schema versions.
 * Handles adding color properties to existing frame shapes.
 *
 * @public
 */
export declare const frameShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLFrameShape.d.ts.map