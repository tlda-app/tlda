/*!
 * MIT License: https://github.com/alexgorbatchev/crc/blob/master/LICENSE
 * Copyright: 2014 Alex Gorbatchev
 * Code: crc32, https://github.com/alexgorbatchev/crc/blob/master/src/calculators/crc32.ts
 */
/**
 * Utility class for reading and manipulating PNG image files.
 * Provides methods for parsing PNG chunks, validating PNG format, and modifying PNG metadata.
 *
 * @example
 * ```ts
 * // Validate PNG file from blob
 * const blob = new Blob([pngData], { type: 'image/png' })
 * const view = new DataView(await blob.arrayBuffer())
 * const isPng = PngHelpers.isPng(view, 0)
 *
 * // Parse PNG metadata for image processing
 * const chunks = PngHelpers.readChunks(view)
 * const physChunk = PngHelpers.findChunk(view, 'pHYs')
 *
 * // Create high-DPI PNG for export
 * const highDpiBlob = PngHelpers.setPhysChunk(view, 2, { type: 'image/png' })
 * ```
 *
 * @public
 */
export declare class PngHelpers {
    /**
     * Checks if binary data at the specified offset contains a valid PNG file signature.
     * Validates the 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A.
     *
     * @param view - DataView containing the binary data to check
     * @param offset - Byte offset where the PNG signature should start
     * @returns True if the data contains a valid PNG signature, false otherwise
     *
     * @example
     * ```ts
     * // Validate PNG from file upload
     * const file = event.target.files[0]
     * const buffer = await file.arrayBuffer()
     * const view = new DataView(buffer)
     *
     * if (PngHelpers.isPng(view, 0)) {
     *   console.log('Valid PNG file detected')
     *   // Process PNG file...
     * } else {
     *   console.error('Not a valid PNG file')
     * }
     * ```
     */
    static isPng(view: DataView, offset: number): boolean;
    /**
     * Reads the 4-character chunk type identifier from a PNG chunk header.
     *
     * @param view - DataView containing the PNG data
     * @param offset - Byte offset of the chunk type field (after length field)
     * @returns 4-character string representing the chunk type (e.g., 'IHDR', 'IDAT', 'IEND')
     *
     * @example
     * ```ts
     * // Read chunk type from PNG header (after 8-byte signature)
     * const chunkType = PngHelpers.getChunkType(dataView, 8)
     * console.log(chunkType) // 'IHDR' (Image Header)
     *
     * // Read chunk type at a specific position during parsing
     * let offset = 8 // Skip PNG signature
     * const chunkLength = dataView.getUint32(offset)
     * const type = PngHelpers.getChunkType(dataView, offset + 4)
     * ```
     */
    static getChunkType(view: DataView, offset: number): string;
    /**
     * Parses all chunks in a PNG file and returns their metadata.
     * Skips duplicate IDAT chunks but includes all other chunk types.
     *
     * @param view - DataView containing the complete PNG file data
     * @param offset - Starting byte offset (defaults to 0)
     * @returns Record mapping chunk types to their metadata (start position, data offset, and size)
     * @throws Error if the data is not a valid PNG file
     *
     * @example
     * ```ts
     * // Parse PNG structure for metadata extraction
     * const view = new DataView(await blob.arrayBuffer())
     * const chunks = PngHelpers.readChunks(view)
     *
     * // Check for specific chunks
     * const ihdrChunk = chunks['IHDR']
     * const physChunk = chunks['pHYs']
     *
     * if (physChunk) {
     *   console.log(`Found pixel density info at byte ${physChunk.start}`)
     * } else {
     *   console.log('No pixel density information found')
     * }
     * ```
     */
    static readChunks(view: DataView, offset?: number): Record<string, {
        dataOffset: number;
        size: number;
        start: number;
    }>;
    /**
     * Parses the pHYs (physical pixel dimensions) chunk data.
     * Reads pixels per unit for X and Y axes, and the unit specifier.
     *
     * @param view - DataView containing the PNG data
     * @param offset - Byte offset of the pHYs chunk data
     * @returns Object with ppux (pixels per unit X), ppuy (pixels per unit Y), and unit specifier
     *
     * @example
     * ```ts
     * // Extract pixel density information for DPI calculation
     * const physChunk = PngHelpers.findChunk(dataView, 'pHYs')
     * if (physChunk) {
     *   const physData = PngHelpers.parsePhys(dataView, physChunk.dataOffset)
     *
     *   if (physData.unit === 1) { // meters
     *     const dpiX = Math.round(physData.ppux * 0.0254)
     *     const dpiY = Math.round(physData.ppuy * 0.0254)
     *     console.log(`DPI: ${dpiX} x ${dpiY}`)
     *   }
     * }
     * ```
     */
    static parsePhys(view: DataView, offset: number): {
        ppux: number;
        ppuy: number;
        unit: number;
    };
    /**
     * Finds a specific chunk type in the PNG file and returns its metadata.
     *
     * @param view - DataView containing the PNG file data
     * @param type - 4-character chunk type to search for (e.g., 'pHYs', 'IDAT')
     * @returns Chunk metadata object if found, undefined otherwise
     *
     * @example
     * ```ts
     * // Look for pixel density information in PNG
     * const physChunk = PngHelpers.findChunk(dataView, 'pHYs')
     * if (physChunk) {
     *   const physData = PngHelpers.parsePhys(dataView, physChunk.dataOffset)
     *   console.log(`Found pHYs chunk with ${physData.ppux} x ${physData.ppuy} pixels per unit`)
     * }
     *
     * // Check for text metadata
     * const textChunk = PngHelpers.findChunk(dataView, 'tEXt')
     * if (textChunk) {
     *   console.log(`Found text metadata at byte ${textChunk.start}`)
     * }
     * ```
     */
    static findChunk(view: DataView, type: string): {
        dataOffset: number;
        size: number;
        start: number;
    };
    /**
     * Adds or replaces a pHYs chunk in a PNG file to set pixel density for high-DPI displays.
     * The method determines insertion point by prioritizing IDAT chunk position over existing pHYs,
     * creates a properly formatted pHYs chunk with CRC validation, and returns a new Blob.
     *
     * @param view - DataView containing the original PNG file data
     * @param dpr - Device pixel ratio multiplier (defaults to 1)
     * @param options - Optional Blob constructor options for MIME type and other properties
     * @returns New Blob containing the PNG with updated pixel density information
     *
     * @example
     * ```ts
     * // Export PNG with proper pixel density for high-DPI displays
     * const canvas = document.createElement('canvas')
     * const ctx = canvas.getContext('2d')
     * // ... draw content to canvas ...
     *
     * canvas.toBlob(async (blob) => {
     *   if (blob) {
     *     const view = new DataView(await blob.arrayBuffer())
     *     // Create 2x DPI version for Retina displays
     *     const highDpiBlob = PngHelpers.setPhysChunk(view, 2, { type: 'image/png' })
     *     // Download or use the blob...
     *   }
     * }, 'image/png')
     * ```
     */
    static setPhysChunk(view: DataView, dpr?: number, options?: BlobPropertyBag): Blob;
}
//# sourceMappingURL=png.d.ts.map