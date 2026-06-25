import { Editor, Result, TLAssetId, TLBookmarkShape, TLShapeId } from '@tldraw/editor';
export declare const BOOKMARK_WIDTH = 300;
export declare const BOOKMARK_HEIGHT = 320;
export declare const BOOKMARK_JUST_URL_HEIGHT = 46;
export declare function getBookmarkHeight(editor: Editor, assetId?: TLAssetId | null): 46 | 101 | 320;
export declare function setBookmarkHeight(editor: Editor, shape: TLBookmarkShape): {
    id: TLShapeId;
    typeName: "shape";
    type: "bookmark";
    x: number;
    y: number;
    rotation: number;
    index: import("@tldraw/utils").IndexKey;
    parentId: import("@tldraw/tlschema").TLParentId;
    isLocked: boolean;
    opacity: number;
    meta: import("@tldraw/utils").JsonObject;
    props: {
        w: number;
        assetId: TLAssetId | null;
        url: string;
        h: number;
    };
};
/** @internal */
export declare function getHumanReadableAddress(url: string): string;
export declare function updateBookmarkAssetOnUrlChange(editor: Editor, shape: TLBookmarkShape): void;
/**
 * Resolve the asset id to render for a bookmark. Bookmark assets are keyed
 * deterministically by URL, so if the shape has no `assetId` but an asset for
 * its URL already exists in the store, use that.
 *
 * This keeps a bookmark from staying stuck on its placeholder after the shape
 * is recreated outside of the hydration flow — e.g. on redo, where the
 * placeholder is restored with a null `assetId` but its hydrated asset (created
 * with `history: 'ignore'`) still lives in the store.
 */
export declare function getResolvedBookmarkAssetId(editor: Editor, assetId: TLAssetId | null, url: string): TLAssetId | null;
/**
 * The effective height to render and measure a bookmark at.
 *
 * Normally this is the stored `props.h`. But when the shape's `assetId` resolves
 * to a different asset than it stores — e.g. a placeholder restored on redo with
 * a null `assetId` whose asset already exists in the store — `props.h` is stale
 * (it still holds the placeholder height). In that case recompute the height
 * from the resolved asset so rendering, the indicator, and the geometry/selection
 * bounds all stay in sync.
 */
export declare function getBookmarkShapeHeight(editor: Editor, shape: TLBookmarkShape): number;
/**
 * Creates a bookmark shape from a URL.
 *
 * The shape is created immediately as a placeholder so the user gets visible
 * feedback at the paste location, and the bookmark metadata (title, description,
 * image, favicon) is fetched in the background. Once metadata resolves, the
 * shape is patched with the resulting asset. If the fetch fails, the shape is
 * left as a URL-only bookmark.
 *
 * @returns A Result containing the created bookmark shape or an error
 * @public
 */
export declare function createBookmarkFromUrl(editor: Editor, { url, center }: {
    url: string;
    center?: {
        x: number;
        y: number;
    };
}): Promise<Result<TLBookmarkShape, string>>;
//# sourceMappingURL=bookmarks.d.ts.map