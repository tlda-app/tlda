import { AssetUtil, TLBookmarkAsset } from '@tldraw/editor';
/** @public */
export declare class BookmarkAssetUtil extends AssetUtil<TLBookmarkAsset> {
    static type: "bookmark";
    static props: {
        title: import("@tldraw/validate").Validator<string>;
        description: import("@tldraw/validate").Validator<string>;
        image: import("@tldraw/validate").Validator<string>;
        favicon: import("@tldraw/validate").Validator<string>;
        src: import("@tldraw/validate").Validator<string | null>;
    };
    static migrations: import("@tldraw/store").MigrationSequence;
    getDefaultProps(): TLBookmarkAsset['props'];
}
//# sourceMappingURL=BookmarkAssetUtil.d.ts.map