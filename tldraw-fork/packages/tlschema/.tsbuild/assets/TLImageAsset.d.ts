import { T } from '@tldraw/validate';
import { TLBaseAsset } from './TLBaseAsset';
/**
 * An asset for images such as PNGs and JPEGs, used by the TLImageShape.
 *
 * @public */
export type TLImageAsset = TLBaseAsset<'image', {
    w: number;
    h: number;
    name: string;
    isAnimated: boolean;
    mimeType: string | null;
    src: string | null;
    fileSize?: number;
    pixelRatio?: number;
}>;
/** @public */
export declare const imageAssetProps: {
    w: T.Validator<number>;
    h: T.Validator<number>;
    name: T.Validator<string>;
    isAnimated: T.Validator<boolean>;
    mimeType: T.Validator<string | null>;
    src: T.Validator<string | null>;
    fileSize: T.Validator<number | undefined>;
    pixelRatio: T.Validator<number | undefined>;
};
/** Validator for image assets. @public */
export declare const imageAssetValidator: T.Validator<TLImageAsset>;
declare const Versions: {
    readonly AddIsAnimated: "com.tldraw.asset.image/1";
    readonly RenameWidthHeight: "com.tldraw.asset.image/2";
    readonly MakeUrlsValid: "com.tldraw.asset.image/3";
    readonly AddFileSize: "com.tldraw.asset.image/4";
    readonly MakeFileSizeOptional: "com.tldraw.asset.image/5";
    readonly AddPixelRatio: "com.tldraw.asset.image/6";
};
/**
 * Migration version identifiers for image assets. These define the different schema versions
 * that image assets have gone through during the evolution of the tldraw data model.
 *
 * @example
 * ```ts
 * import { imageAssetVersions } from '@tldraw/tlschema'
 *
 * // Access specific version IDs
 * console.log(imageAssetVersions.AddIsAnimated) // Version when isAnimated was added
 * console.log(imageAssetVersions.RenameWidthHeight) // Version when width/height became w/h
 * ```
 *
 * @public
 */
export { Versions as imageAssetVersions };
/**
 * Migration sequence for image assets. Handles the evolution of the image asset schema
 * over time, providing both forward (up) and backward (down) migration functions to
 * maintain compatibility across different versions of the tldraw data model.
 *
 * The sequence includes migrations for:
 * - Adding the `isAnimated` property to track animated images
 * - Renaming `width`/`height` properties to shorter `w`/`h` names
 * - Ensuring URLs are valid format
 * - Adding file size tracking
 * - Making file size optional
 *
 *
 * @public
 */
export declare const imageAssetMigrations: import("@tldraw/store").MigrationSequence;
//# sourceMappingURL=TLImageAsset.d.ts.map