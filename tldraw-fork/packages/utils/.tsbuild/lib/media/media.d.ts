/**
 * Array of supported vector image MIME types.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORTED_VECTOR_IMAGE_TYPES } from '@tldraw/utils'
 *
 * const isSvg = DEFAULT_SUPPORTED_VECTOR_IMAGE_TYPES.includes('image/svg+xml')
 * console.log(isSvg) // true
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORTED_VECTOR_IMAGE_TYPES: readonly "image/svg+xml"[];
/**
 * Array of supported static (non-animated) image MIME types.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES } from '@tldraw/utils'
 *
 * const isStatic = DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES.includes('image/jpeg')
 * console.log(isStatic) // true
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORTED_STATIC_IMAGE_TYPES: readonly ("image/jpeg" | "image/png" | "image/webp")[];
/**
 * Array of supported animated image MIME types.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORTED_ANIMATED_IMAGE_TYPES } from '@tldraw/utils'
 *
 * const isAnimated = DEFAULT_SUPPORTED_ANIMATED_IMAGE_TYPES.includes('image/gif')
 * console.log(isAnimated) // true
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORTED_ANIMATED_IMAGE_TYPES: readonly ("image/apng" | "image/avif" | "image/gif")[];
/**
 * Array of all supported image MIME types, combining static, vector, and animated types.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORTED_IMAGE_TYPES } from '@tldraw/utils'
 *
 * const isSupported = DEFAULT_SUPPORTED_IMAGE_TYPES.includes('image/png')
 * console.log(isSupported) // true
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORTED_IMAGE_TYPES: readonly ("image/apng" | "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp")[];
/**
 * Array of supported video MIME types.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORT_VIDEO_TYPES } from '@tldraw/utils'
 *
 * const isVideo = DEFAULT_SUPPORT_VIDEO_TYPES.includes('video/mp4')
 * console.log(isVideo) // true
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORT_VIDEO_TYPES: readonly ("video/mp4" | "video/quicktime" | "video/webm")[];
/**
 * Array of all supported media MIME types, combining images and videos.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORTED_MEDIA_TYPES } from '@tldraw/utils'
 *
 * const isMediaFile = DEFAULT_SUPPORTED_MEDIA_TYPES.includes('video/mp4')
 * console.log(isMediaFile) // true
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORTED_MEDIA_TYPES: readonly ("image/apng" | "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/svg+xml" | "image/webp" | "video/mp4" | "video/quicktime" | "video/webm")[];
/**
 * Comma-separated string of all supported media MIME types, useful for HTML file input accept attributes.
 *
 * @example
 * ```ts
 * import { DEFAULT_SUPPORTED_MEDIA_TYPE_LIST } from '@tldraw/utils'
 *
 * // Use in HTML file input for media uploads
 * const input = document.createElement('input')
 * input.type = 'file'
 * input.accept = DEFAULT_SUPPORTED_MEDIA_TYPE_LIST
 * input.addEventListener('change', (e) => {
 *   const files = (e.target as HTMLInputElement).files
 *   if (files) console.log(`Selected ${files.length} file(s)`)
 * })
 * ```
 * @public
 */
export declare const DEFAULT_SUPPORTED_MEDIA_TYPE_LIST: string;
/**
 * Helpers for media
 *
 * @public
 */
export declare class MediaHelpers {
    /**
     * Load a video element from a URL with cross-origin support.
     *
     * @param src - The URL of the video to load
     * @param doc - Optional document to create the video element in
     * @returns Promise that resolves to the loaded HTMLVideoElement
     * @example
     * ```ts
     * const video = await MediaHelpers.loadVideo('https://example.com/video.mp4')
     * console.log(`Video dimensions: ${video.videoWidth}x${video.videoHeight}`)
     * ```
     * @public
     */
    static loadVideo(src: string, doc?: Document): Promise<HTMLVideoElement>;
    /**
     * Extract a frame from a video element as a data URL.
     *
     * @param video - The HTMLVideoElement to extract frame from
     * @param time - The time in seconds to extract the frame from (default: 0)
     * @returns Promise that resolves to a data URL of the video frame
     * @example
     * ```ts
     * const video = await MediaHelpers.loadVideo('https://example.com/video.mp4')
     * const frameDataUrl = await MediaHelpers.getVideoFrameAsDataUrl(video, 5.0)
     * // Use frameDataUrl as image thumbnail
     * const img = document.createElement('img')
     * img.src = frameDataUrl
     * ```
     * @public
     */
    static getVideoFrameAsDataUrl(video: HTMLVideoElement, time?: number): Promise<string>;
    /**
     * Load an image from a URL and get its dimensions along with the image element.
     *
     * @param src - The URL of the image to load
     * @param doc - Optional document to use for DOM operations (e.g. measuring SVG dimensions)
     * @returns Promise that resolves to an object with width, height, and the image element
     * @example
     * ```ts
     * const { w, h, image } = await MediaHelpers.getImageAndDimensions('https://example.com/image.png')
     * console.log(`Image size: ${w}x${h}`)
     * // Image is ready to use
     * document.body.appendChild(image)
     * ```
     * @public
     */
    static getImageAndDimensions(src: string, doc?: Document): Promise<{
        w: number;
        h: number;
        image: HTMLImageElement;
    }>;
    /**
     * Get the size of a video blob
     *
     * @param blob - A Blob containing the video
     * @param doc - Optional document to create elements in
     * @returns Promise that resolves to an object with width and height properties
     * @example
     * ```ts
     * const file = new File([...], 'video.mp4', { type: 'video/mp4' })
     * const { w, h } = await MediaHelpers.getVideoSize(file)
     * console.log(`Video dimensions: ${w}x${h}`)
     * ```
     * @public
     */
    static getVideoSize(blob: Blob, doc?: Document): Promise<{
        w: number;
        h: number;
    }>;
    /**
     * Get the size of an image blob
     *
     * @param blob - A Blob containing the image
     * @param doc - Optional document to use for DOM operations
     * @returns Promise that resolves to an object with width and height properties
     * @example
     * ```ts
     * const file = new File([...], 'image.png', { type: 'image/png' })
     * const { w, h } = await MediaHelpers.getImageSize(file)
     * console.log(`Image dimensions: ${w}x${h}`)
     * ```
     * @public
     */
    static getImageSize(blob: Blob, doc?: Document): Promise<{
        w: number;
        h: number;
        pixelRatio: number;
    }>;
    /**
     * Check if a media file blob contains animation data.
     *
     * @param file - The Blob to check for animation
     * @returns Promise that resolves to true if the file is animated, false otherwise
     * @example
     * ```ts
     * const file = new File([...], 'animation.gif', { type: 'image/gif' })
     * const animated = await MediaHelpers.isAnimated(file)
     * console.log(animated ? 'Animated' : 'Static')
     * ```
     * @public
     */
    static isAnimated(file: Blob): Promise<boolean>;
    /**
     * Check if a MIME type represents an animated image format.
     *
     * @param mimeType - The MIME type to check
     * @returns True if the MIME type is an animated image format, false otherwise
     * @example
     * ```ts
     * const isAnimated = MediaHelpers.isAnimatedImageType('image/gif')
     * console.log(isAnimated) // true
     * ```
     * @public
     */
    static isAnimatedImageType(mimeType: string | null): boolean;
    /**
     * Check if a MIME type represents a static (non-animated) image format.
     *
     * @param mimeType - The MIME type to check
     * @returns True if the MIME type is a static image format, false otherwise
     * @example
     * ```ts
     * const isStatic = MediaHelpers.isStaticImageType('image/jpeg')
     * console.log(isStatic) // true
     * ```
     * @public
     */
    static isStaticImageType(mimeType: string | null): boolean;
    /**
     * Check if a MIME type represents a vector image format.
     *
     * @param mimeType - The MIME type to check
     * @returns True if the MIME type is a vector image format, false otherwise
     * @example
     * ```ts
     * const isVector = MediaHelpers.isVectorImageType('image/svg+xml')
     * console.log(isVector) // true
     * ```
     * @public
     */
    static isVectorImageType(mimeType: string | null): boolean;
    /**
     * Check if a MIME type represents any supported image format (static, animated, or vector).
     *
     * @param mimeType - The MIME type to check
     * @returns True if the MIME type is a supported image format, false otherwise
     * @example
     * ```ts
     * const isImage = MediaHelpers.isImageType('image/png')
     * console.log(isImage) // true
     * ```
     * @public
     */
    static isImageType(mimeType: string): boolean;
    /**
     * Utility function to create an object URL from a blob, execute a function with it, and automatically clean it up.
     *
     * @param blob - The Blob to create an object URL for
     * @param fn - Function to execute with the object URL
     * @returns Promise that resolves to the result of the function
     * @example
     * ```ts
     * const result = await MediaHelpers.usingObjectURL(imageBlob, async (url) => {
     *   const { w, h } = await MediaHelpers.getImageAndDimensions(url)
     *   return { width: w, height: h }
     * })
     * // Object URL is automatically revoked after function completes
     * console.log(`Image dimensions: ${result.width}x${result.height}`)
     * ```
     * @public
     */
    static usingObjectURL<T>(blob: Blob, fn: (url: string) => Promise<T>): Promise<T>;
}
//# sourceMappingURL=media.d.ts.map