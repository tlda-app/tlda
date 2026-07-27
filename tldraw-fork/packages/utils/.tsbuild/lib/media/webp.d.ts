/*!
 * MIT License: https://github.com/sindresorhus/is-webp/blob/main/license
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 */
/**
 * Determines whether a byte array represents a WebP image by checking the WebP file signature.
 *
 * @param view - The Uint8Array containing the potential WebP image data
 * @returns True if the byte array is a valid WebP image, false otherwise
 * @example
 * ```ts
 * // Check if file data is WebP format
 * const file = new File([...], 'image.webp', { type: 'image/webp' })
 * const buffer = await file.arrayBuffer()
 * const view = new Uint8Array(buffer)
 * const isWebPImage = isWebp(view)
 * console.log(isWebPImage ? 'Valid WebP' : 'Not WebP')
 * ```
 * @internal
 */
export declare function isWebp(view: Uint8Array): boolean;
/**
 * Determines whether a WebP image file contains animation data by checking the animation flag in the WebP VP8X chunk.
 *
 * @param buffer - The ArrayBuffer containing the WebP image data
 * @returns True if the WebP image is animated, false otherwise
 * @example
 * ```ts
 * // Check if a WebP file from user input is animated
 * const file = new File([...], 'image.webp', { type: 'image/webp' })
 * const buffer = await file.arrayBuffer()
 * const animated = isWebpAnimated(buffer)
 * console.log(animated ? 'Animated WebP' : 'Static WebP')
 * ```
 * @public
 */
export declare function isWebpAnimated(buffer: ArrayBuffer): boolean;
//# sourceMappingURL=webp.d.ts.map