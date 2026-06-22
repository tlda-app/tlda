/*!
 * MIT License: https://github.com/vHeemstra/is-apng/blob/main/license
 * Copyright (c) Philip van Heemstra
 */
/**
 * Determines whether an ArrayBuffer contains an animated PNG (APNG) image.
 *
 * This function checks if the provided buffer contains a valid PNG file with animation
 * control chunks (acTL) that precede the image data chunks (IDAT), which indicates
 * it's an animated PNG rather than a static PNG.
 *
 * @param buffer - The ArrayBuffer containing the image data to analyze
 * @returns True if the buffer contains an animated PNG, false otherwise
 *
 * @example
 * ```typescript
 * // Check if an uploaded file contains an animated PNG
 * if (file.type === 'image/apng') {
 *   const isAnimated = isApngAnimated(await file.arrayBuffer())
 *   console.log(isAnimated ? 'Animated PNG' : 'Static PNG')
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Use with fetch to check remote images
 * const response = await fetch('image.png')
 * const buffer = await response.arrayBuffer()
 * const hasAnimation = isApngAnimated(buffer)
 * ```
 *
 * @public
 */
export declare function isApngAnimated(buffer: ArrayBuffer): boolean;
//# sourceMappingURL=apng.d.ts.map