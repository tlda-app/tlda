import { AssetUtil, TLAssetId, TLImageAsset } from '@tldraw/editor';
/** @public */
export declare class ImageAssetUtil extends AssetUtil<TLImageAsset> {
    static type: "image";
    static props: {
        w: import("@tldraw/validate").Validator<number>;
        h: import("@tldraw/validate").Validator<number>;
        name: import("@tldraw/validate").Validator<string>;
        isAnimated: import("@tldraw/validate").Validator<boolean>;
        mimeType: import("@tldraw/validate").Validator<string | null>;
        src: import("@tldraw/validate").Validator<string | null>;
        fileSize: import("@tldraw/validate").Validator<number | undefined>;
        pixelRatio: import("@tldraw/validate").Validator<number | undefined>;
    };
    static migrations: import("@tldraw/store").MigrationSequence;
    options: {
        maxDimension: number;
        supportedMimeTypes: readonly string[] | null;
    };
    getDefaultProps(): TLImageAsset['props'];
    getSupportedMimeTypes(): readonly string[];
    getAssetFromFile(file: File, assetId: TLAssetId): Promise<TLImageAsset | null>;
}
//# sourceMappingURL=ImageAssetUtil.d.ts.map