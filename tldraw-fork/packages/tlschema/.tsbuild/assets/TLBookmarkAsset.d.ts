import { T } from '@tldraw/validate';
import { TLBaseAsset } from './TLBaseAsset';
/**
 * An asset used for URL bookmarks, used by the TLBookmarkShape.
 *
 *  @public */
export type TLBookmarkAsset = TLBaseAsset<'bookmark', {
    title: string;
    description: string;
    image: string;
    favicon: string;
    src: string | null;
}>;
/** @public */
export declare const bookmarkAssetProps: {
    title: T.Validator<string>;
    description: T.Validator<string>;
    image: T.Validator<string>;
    favicon: T.Validator<string>;
    src: T.Validator<string | null>;
};
/** Validator for bookmark assets. @public */
export declare const bookmarkAssetValidator: T.Validator<TLBookmarkAsset>;
declare const Versions: {
    readonly MakeUrlsValid: "com.tldraw.asset.bookmark/1";
    readonly AddFavicon: "com.tldraw.asset.bookmark/2";
};
/**
 * Migration version identifiers for bookmark assets. These versions track
 * the evolution of the bookmark asset schema over time.
 *
 * Available versions:
 * - `MakeUrlsValid` (v1): Ensures src URLs are valid or empty
 * - `AddFavicon` (v2): Adds favicon property to bookmark assets
 *
 * @example
 * ```ts
 * import { bookmarkAssetVersions } from '@tldraw/tlschema'
 *
 * // Check if a migration exists
 * console.log(bookmarkAssetVersions.AddFavicon) // 2
 * ```
 *
 * @public
 */
export { Versions as bookmarkAssetVersions };
/**
 * Migration sequence for bookmark assets. Handles the evolution of bookmark asset
 * data structure over time, ensuring backward and forward compatibility.
 *
 * The migration sequence includes:
 * 1. **MakeUrlsValid** (v1): Validates and cleans up src URLs, setting invalid URLs to empty string
 * 2. **AddFavicon** (v2): Adds the favicon property and validates it, setting invalid favicons to empty string
 *
 * @public
 */
export declare const bookmarkAssetMigrations: import("@tldraw/store").MigrationSequence;
//# sourceMappingURL=TLBookmarkAsset.d.ts.map