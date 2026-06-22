/** @public */
export interface BoxWidthHeight {
    w: number;
    h: number;
}
/**
 * Contains the size within the given box size
 *
 * @param originalSize - The size of the asset
 * @param containBoxSize - The container size
 * @returns Adjusted size
 * @public
 */
export declare function containBoxSize(originalSize: BoxWidthHeight, containBoxSize: BoxWidthHeight): BoxWidthHeight;
/**
 * Resize an image Blob to be smaller than it is currently.
 *
 * @example
 * ```ts
 * const image = await (await fetch('/image.jpg')).blob()
 * const size = await getImageSize(image)
 * const resizedImage = await downsizeImage(image, size.w / 2, size.h / 2, { type: "image/jpeg", quality: 0.85 })
 * ```
 *
 * @param image - The image Blob.
 * @param width - The desired width.
 * @param height - The desired height.
 * @param opts - Options for the image.
 * @public
 */
export declare function downsizeImage(blob: Blob, width: number, height: number, opts?: {
    type?: string | undefined;
    quality?: number | undefined;
}): Promise<Blob>;
//# sourceMappingURL=assets.d.ts.map