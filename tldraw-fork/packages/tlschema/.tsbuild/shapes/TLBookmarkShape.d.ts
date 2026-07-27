import { TLAssetId } from '../records/TLAsset';
import { RecordProps } from '../recordsWithProps';
import { TLBaseShape } from './TLBaseShape';
/**
 * Properties for the bookmark shape, which displays website bookmarks as interactive cards.
 *
 * @public
 */
export interface TLBookmarkShapeProps {
    /** Width of the bookmark shape in pixels */
    w: number;
    /** Height of the bookmark shape in pixels */
    h: number;
    /** Asset ID for the bookmark's preview image, or null if no image is available */
    assetId: TLAssetId | null;
    /** The URL that this bookmark points to */
    url: string;
}
/**
 * A bookmark shape represents a website link with optional preview content.
 * Bookmark shapes display as cards showing the page title, description, and preview image.
 *
 * @public
 * @example
 * ```ts
 * const bookmarkShape: TLBookmarkShape = {
 *   id: createShapeId(),
 *   typeName: 'shape',
 *   type: 'bookmark',
 *   x: 100,
 *   y: 100,
 *   rotation: 0,
 *   index: 'a1',
 *   parentId: 'page:page1',
 *   isLocked: false,
 *   opacity: 1,
 *   props: {
 *     w: 300,
 *     h: 320,
 *     assetId: 'asset:bookmark123',
 *     url: 'https://www.example.com'
 *   },
 *   meta: {}
 * }
 * ```
 */
export type TLBookmarkShape = TLBaseShape<'bookmark', TLBookmarkShapeProps>;
/**
 * Validation schema for bookmark shape properties.
 *
 * @public
 * @example
 * ```ts
 * // Validates bookmark shape properties
 * const isValid = bookmarkShapeProps.url.isValid('https://example.com')
 * ```
 */
export declare const bookmarkShapeProps: RecordProps<TLBookmarkShape>;
declare const Versions: {
    readonly NullAssetId: "com.tldraw.shape.bookmark/1";
    readonly MakeUrlsValid: "com.tldraw.shape.bookmark/2";
};
/**
 * Version identifiers for bookmark shape migrations.
 *
 * @public
 */
export { Versions as bookmarkShapeVersions };
/**
 * Migration sequence for bookmark shape properties across different schema versions.
 * Handles backwards compatibility when bookmark shape structure changes.
 *
 * @public
 */
export declare const bookmarkShapeMigrations: import("..").TLPropsMigrations;
//# sourceMappingURL=TLBookmarkShape.d.ts.map