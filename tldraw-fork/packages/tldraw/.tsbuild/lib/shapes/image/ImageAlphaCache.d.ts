import { VecLike } from '@tldraw/editor';
/** Mime types of image formats that support transparency / alpha channel. */
export declare const TRANSPARENT_IMAGE_MIMETYPES: readonly string[];
/** Alpha channel data for an image, downsampled for efficient hit testing. */
export interface AlphaData {
    width: number;
    height: number;
    /** Row-major alpha values (0–255) */
    alphas: Uint8Array;
}
/** Shared config for image geometries that support alpha hit testing. */
export interface ImageAlphaGeometryConfig {
    alphaDataGetter(): AlphaData | null;
    crop: {
        topLeft: {
            x: number;
            y: number;
        };
        bottomRight: {
            x: number;
            y: number;
        };
    } | null;
    flipX: boolean;
    flipY: boolean;
}
/** Returns true if the point maps to a transparent pixel. Returns false if alpha data isn't loaded yet. */
export declare function isImagePointTransparent(config: ImageAlphaGeometryConfig, point: VecLike, bounds: {
    minX: number;
    minY: number;
    w: number;
    h: number;
}): boolean;
/**
 * Start loading alpha data for a given image URL. No-op if already loaded or loading.
 *
 * @param url - The URL to fetch the image from (may be a resolved/optimized CDN URL).
 * @param cacheKey - The key to store/lookup the alpha data under. Defaults to `url`.
 *   Pass `asset.props.src` here so that `getAlphaData(asset.props.src)` in getGeometry
 *   finds data that was preloaded from a resolved URL.
 */
export declare function preloadAlphaData(url: string, cacheKey?: string): void;
/** Get cached alpha data for a URL, or null if not yet loaded. */
export declare function getAlphaData(src: string): AlphaData | null;
/**
 * Check whether a point in normalized [0,1] coordinates falls on a transparent pixel.
 * Returns true if the pixel's alpha is below the threshold.
 */
export declare function isPointTransparent(data: AlphaData, nx: number, ny: number, threshold?: number): boolean;
//# sourceMappingURL=ImageAlphaCache.d.ts.map