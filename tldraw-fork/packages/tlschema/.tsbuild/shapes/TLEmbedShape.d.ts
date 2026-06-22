import { RecordProps } from '../recordsWithProps';
import { TLBaseShape } from './TLBaseShape';
/**
 * Properties for the embed shape, which displays embedded content from external services.
 *
 * @public
 */
export interface TLEmbedShapeProps {
    /** Width of the embed shape in pixels */
    w: number;
    /** Height of the embed shape in pixels */
    h: number;
    /** URL of the content to embed (supports YouTube, Figma, CodePen, etc.) */
    url: string;
}
/**
 * An embed shape displays external content like YouTube videos, Figma designs, CodePen demos,
 * and other embeddable content within the tldraw canvas.
 *
 * @public
 * @example
 * ```ts
 * const embedShape: TLEmbedShape = {
 *   id: createShapeId(),
 *   typeName: 'shape',
 *   type: 'embed',
 *   x: 200,
 *   y: 200,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:page1',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     w: 560,
 *     h: 315,
 *     url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
 *   },
 *   meta: {}
 * }
 * ```
 */
export type TLEmbedShape = TLBaseShape<'embed', TLEmbedShapeProps>;
/**
 * Validation schema for embed shape properties.
 *
 * @public
 * @example
 * ```ts
 * // Validate embed shape properties
 * const isValidUrl = embedShapeProps.url.isValid('https://youtube.com/watch?v=abc123')
 * const isValidSize = embedShapeProps.w.isValid(560)
 * ```
 */
export declare const embedShapeProps: RecordProps<TLEmbedShape>;
declare const Versions: {
    readonly GenOriginalUrlInEmbed: "com.tldraw.shape.embed/1";
    readonly RemoveDoesResize: "com.tldraw.shape.embed/2";
    readonly RemoveTmpOldUrl: "com.tldraw.shape.embed/3";
    readonly RemovePermissionOverrides: "com.tldraw.shape.embed/4";
};
/**
 * Version identifiers for embed shape migrations.
 *
 * @public
 */
export { Versions as embedShapeVersions };
/**
 * Migration sequence for embed shape properties across different schema versions.
 * Handles URL transformations and removal of deprecated properties.
 *
 * @public
 */
export declare const embedShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLEmbedShape.d.ts.map