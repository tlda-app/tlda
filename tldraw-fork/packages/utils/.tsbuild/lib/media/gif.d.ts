/*!
 * MIT License
 * Modified code originally from <https://github.com/qzb/is-animated>
 * Copyright (c) 2016 Józef Sokołowski <j.k.sokolowski@gmail.com>
 */
/**
 * Checks if buffer contains GIF image by examining the file header.
 *
 * @param buffer - The ArrayBuffer containing the image data to check
 * @returns True if the buffer contains a GIF image, false otherwise
 * @example
 * ```ts
 * // Check a file from user input
 * const file = event.target.files[0]
 * const buffer = await file.arrayBuffer()
 * const isGif = isGIF(buffer)
 * console.log(isGif ? 'GIF image' : 'Not a GIF')
 * ```
 * @public
 */
export declare function isGIF(buffer: ArrayBuffer): boolean;
/**
 * Checks if buffer contains animated GIF image by parsing the GIF structure and counting image descriptors.
 * A GIF is considered animated if it contains more than one image descriptor block.
 *
 * @param buffer - The ArrayBuffer containing the GIF image data
 * @returns True if the GIF is animated (contains multiple frames), false otherwise
 * @example
 * ```ts
 * // Check if a GIF file is animated
 * const file = event.target.files[0]
 * if (file.type === 'image/gif') {
 *   const buffer = await file.arrayBuffer()
 *   const animated = isGifAnimated(buffer)
 *   console.log(animated ? 'Animated GIF' : 'Static GIF')
 * }
 * ```
 * @public
 */
export declare function isGifAnimated(buffer: ArrayBuffer): boolean;
//# sourceMappingURL=gif.d.ts.map