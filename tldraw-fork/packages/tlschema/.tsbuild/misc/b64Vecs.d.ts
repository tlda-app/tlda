import { VecModel } from './geometry-types';
declare global {
    interface Uint8Array {
        toBase64?(): string;
    }
    interface Uint8ArrayConstructor {
        fromBase64?(base64: string): Uint8Array;
    }
}
/** @internal */
export declare function fallbackBase64ToUint8Array(base64: string): Uint8Array;
/** @internal */
export declare function fallbackUint8ArrayToBase64(uint8Array: Uint8Array): string;
/**
 * Convert Float16 bits to a number using optimized lookup tables.
 * Handles normal numbers, subnormal numbers, zero, infinity, and NaN.
 *
 * @param bits - The 16-bit Float16 value to decode
 * @returns The decoded number value
 * @internal
 */
export declare function float16BitsToNumber(bits: number): number;
/**
 * Convert a number to Float16 bits.
 * Handles normal numbers, subnormal numbers, zero, infinity, and NaN.
 *
 * @param value - The number to encode as Float16
 * @returns The 16-bit Float16 representation of the number
 * @internal
 */
export declare function numberToFloat16Bits(value: number): number;
/**
 * Utilities for encoding and decoding points using base64 and Float16 encoding.
 * Provides functions for converting between VecModel arrays and compact base64 strings,
 * as well as individual point encoding/decoding operations.
 *
 * @public
 */
export declare class b64Vecs {
    /**
     * Encode a single point (x, y, z) to 8 base64 characters using legacy Float16 encoding.
     * Each coordinate is encoded as a Float16 value, resulting in 6 bytes total.
     *
     * @param x - The x coordinate
     * @param y - The y coordinate
     * @param z - The z coordinate
     * @returns An 8-character base64 string representing the point
     * @internal
     */
    static _legacyEncodePoint(x: number, y: number, z: number): string;
    /**
     * Convert an array of VecModels to a base64 string using legacy Float16 encoding.
     * Uses Float16 encoding for each coordinate (x, y, z). If a point's z value is
     * undefined, it defaults to 0.5.
     *
     * @param points - An array of VecModel objects to encode
     * @returns A base64-encoded string containing all points
     * @internal Used only for migrations from legacy format
     */
    static _legacyEncodePoints(points: VecModel[]): string;
    /**
     * Convert a legacy base64 string back to an array of VecModels.
     * Decodes Float16-encoded coordinates (x, y, z) from the base64 string.
     *
     * @param base64 - The base64-encoded string containing point data
     * @returns An array of VecModel objects decoded from the string
     * @internal Used only for migrations from legacy format
     */
    static _legacyDecodePoints(base64: string): VecModel[];
    /**
     * Encode an array of VecModels using delta encoding for improved precision.
     * The first point is stored as Float32 (high precision for absolute position),
     * subsequent points are stored as Float16 deltas from the previous point.
     * This provides full precision for the starting position and excellent precision
     * for deltas between consecutive points (which are typically small values).
     *
     * Format:
     * - First point: 3 Float32 values = 12 bytes = 16 base64 chars
     * - Delta points: 3 Float16 values each = 6 bytes = 8 base64 chars each
     *
     * @param points - An array of VecModel objects to encode
     * @returns A base64-encoded string containing delta-encoded points
     * @public
     */
    static encodePoints(points: VecModel[]): string;
    /**
     * Decode a delta-encoded base64 string back to an array of absolute VecModels.
     * The first point is stored as Float32 (high precision), subsequent points are
     * Float16 deltas that are accumulated to reconstruct absolute positions.
     *
     * @param base64 - The base64-encoded string containing delta-encoded point data
     * @returns An array of VecModel objects with absolute coordinates
     * @public
     */
    static decodePoints(base64: string): VecModel[];
    /**
     * Get the first point from a delta-encoded base64 string.
     * The first point is stored as Float32 for full precision.
     *
     * @param b64Points - The delta-encoded base64 string
     * @returns The first point as a VecModel, or null if the string is too short
     * @public
     */
    static decodeFirstPoint(b64Points: string): VecModel | null;
    /**
     * Get the last point from a delta-encoded base64 string.
     * Requires decoding all points to accumulate deltas.
     *
     * @param b64Points - The delta-encoded base64 string
     * @returns The last point as a VecModel, or null if the string is too short
     * @public
     */
    static decodeLastPoint(b64Points: string): VecModel | null;
}
//# sourceMappingURL=b64Vecs.d.ts.map