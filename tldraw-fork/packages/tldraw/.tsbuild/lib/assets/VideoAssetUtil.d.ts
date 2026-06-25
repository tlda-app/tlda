import { AssetUtil, TLAssetId, TLVideoAsset } from '@tldraw/editor';
/** @public */
export declare class VideoAssetUtil extends AssetUtil<TLVideoAsset> {
    static type: "video";
    static props: {
        w: import("@tldraw/validate").Validator<number>;
        h: import("@tldraw/validate").Validator<number>;
        name: import("@tldraw/validate").Validator<string>;
        isAnimated: import("@tldraw/validate").Validator<boolean>;
        mimeType: import("@tldraw/validate").Validator<string | null>;
        src: import("@tldraw/validate").Validator<string | null>;
        fileSize: import("@tldraw/validate").Validator<number | undefined>;
    };
    static migrations: import("@tldraw/store").MigrationSequence;
    options: {
        supportedMimeTypes: readonly string[] | null;
    };
    getDefaultProps(): TLVideoAsset['props'];
    getSupportedMimeTypes(): readonly string[];
    getAssetFromFile(file: File, assetId: TLAssetId): Promise<TLVideoAsset | null>;
}
//# sourceMappingURL=VideoAssetUtil.d.ts.map