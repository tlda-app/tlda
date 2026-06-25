import { T } from '@tldraw/validate';
import { TLBaseAsset } from './TLBaseAsset';
/**
 * An asset record representing video files that can be displayed in video shapes.
 * Video assets store metadata about video files including dimensions, MIME type,
 * animation status, and file source information. They are referenced by TLVideoShape
 * instances to display video content on the canvas.
 *
 * @example
 * ```ts
 * import { TLVideoAsset } from '@tldraw/tlschema'
 *
 * const videoAsset: TLVideoAsset = {
 *   id: 'asset:video123',
 *   typeName: 'asset',
 *   type: 'video',
 *   props: {
 *     w: 1920,
 *     h: 1080,
 *     name: 'my-video.mp4',
 *     isAnimated: true,
 *     mimeType: 'video/mp4',
 *     src: 'https://example.com/video.mp4',
 *     fileSize: 5242880
 *   },
 *   meta: {}
 * }
 * ```
 *
 * @public
 */
export type TLVideoAsset = TLBaseAsset<'video', {
    /** The width of the video in pixels */
    w: number;
    /** The height of the video in pixels */
    h: number;
    /** The original filename or display name of the video */
    name: string;
    /** Whether the video contains animation/motion (true for most videos) */
    isAnimated: boolean;
    /** The MIME type of the video file (e.g., 'video/mp4', 'video/webm'), null if unknown */
    mimeType: string | null;
    /** The source URL or data URI for the video file, null if not yet available */
    src: string | null;
    /** The file size in bytes, optional for backward compatibility */
    fileSize?: number;
}>;
/** @public */
export declare const videoAssetProps: {
    w: T.Validator<number>;
    h: T.Validator<number>;
    name: T.Validator<string>;
    isAnimated: T.Validator<boolean>;
    mimeType: T.Validator<string | null>;
    src: T.Validator<string | null>;
    fileSize: T.Validator<number | undefined>;
};
/** Validator for video assets. @public */
export declare const videoAssetValidator: T.Validator<TLVideoAsset>;
declare const Versions: {
    readonly AddIsAnimated: "com.tldraw.asset.video/1";
    readonly RenameWidthHeight: "com.tldraw.asset.video/2";
    readonly MakeUrlsValid: "com.tldraw.asset.video/3";
    readonly AddFileSize: "com.tldraw.asset.video/4";
    readonly MakeFileSizeOptional: "com.tldraw.asset.video/5";
};
/**
 * Version identifiers for video asset migration sequences. These versions track
 * the evolution of the video asset schema over time, enabling proper data migration
 * when the asset structure changes.
 *
 * @example
 * ```ts
 * import { videoAssetVersions } from '@tldraw/tlschema'
 *
 * // Check the current version of a specific migration
 * console.log(videoAssetVersions.AddFileSize) // 4
 * ```
 *
 * @public
 */
export { Versions as videoAssetVersions };
/**
 * Migration sequence for video assets that handles schema evolution over time.
 * This sequence defines how video asset data should be transformed when upgrading
 * or downgrading between different schema versions. Each migration step handles
 * specific changes like adding properties, renaming fields, or changing data formats.
 *
 * The migrations handle:
 * - Adding animation detection (isAnimated property)
 * - Renaming width/height properties to w/h for consistency
 * - Ensuring URL validity for src properties
 * - Adding file size tracking
 * - Making file size optional for backward compatibility
 *
 * @public
 */
export declare const videoAssetMigrations: import("@tldraw/store").MigrationSequence;
//# sourceMappingURL=TLVideoAsset.d.ts.map