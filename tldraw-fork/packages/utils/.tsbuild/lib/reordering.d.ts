/**
 * A string made up of an integer part followed by a fraction part. The fraction point consists of
 * zero or more digits with no trailing zeros. Based on
 * {@link https://observablehq.com/@dgreensp/implementing-fractional-indexing}.
 *
 * @public
 */
export type IndexKey = string & {
    __brand: 'indexKey';
};
/**
 * The index key for the first index - 'a0'.
 * @public
 */
export declare const ZERO_INDEX_KEY: IndexKey;
/**
 * Validates that a string is a valid IndexKey.
 * @param index - The string to validate.
 * @throws Error if the index is invalid.
 * @internal
 */
export declare function validateIndexKey(index: string): asserts index is IndexKey;
/**
 * Get a number of indices between two indices.
 * @param below - The index below.
 * @param above - The index above.
 * @param n - The number of indices to get.
 * @returns An array of n IndexKey values between below and above.
 * @example
 * ```ts
 * const indices = getIndicesBetween('a0' as IndexKey, 'a2' as IndexKey, 2)
 * console.log(indices) // ['a0V', 'a1']
 * ```
 * @public
 */
export declare function getIndicesBetween(below: IndexKey | null | undefined, above: IndexKey | null | undefined, n: number): IndexKey[];
/**
 * Get a number of indices above an index.
 * @param below - The index below.
 * @param n - The number of indices to get.
 * @returns An array of n IndexKey values above the given index.
 * @example
 * ```ts
 * const indices = getIndicesAbove('a0' as IndexKey, 3)
 * console.log(indices) // ['a1', 'a2', 'a3']
 * ```
 * @public
 */
export declare function getIndicesAbove(below: IndexKey | null | undefined, n: number): IndexKey[];
/**
 * Get a number of indices below an index.
 * @param above - The index above.
 * @param n - The number of indices to get.
 * @returns An array of n IndexKey values below the given index.
 * @example
 * ```ts
 * const indices = getIndicesBelow('a2' as IndexKey, 2)
 * console.log(indices) // ['a1', 'a0V']
 * ```
 * @public
 */
export declare function getIndicesBelow(above: IndexKey | null | undefined, n: number): IndexKey[];
/**
 * Get the index between two indices.
 * @param below - The index below.
 * @param above - The index above.
 * @returns A single IndexKey value between below and above.
 * @example
 * ```ts
 * const index = getIndexBetween('a0' as IndexKey, 'a2' as IndexKey)
 * console.log(index) // 'a1'
 * ```
 * @public
 */
export declare function getIndexBetween(below: IndexKey | null | undefined, above: IndexKey | null | undefined): IndexKey;
/**
 * Get the index above a given index.
 * @param below - The index below.
 * @returns An IndexKey value above the given index.
 * @example
 * ```ts
 * const index = getIndexAbove('a0' as IndexKey)
 * console.log(index) // 'a1'
 * ```
 * @public
 */
export declare function getIndexAbove(below?: IndexKey | null | undefined): IndexKey;
/**
 * Get the index below a given index.
 * @param above - The index above.
 * @returns An IndexKey value below the given index.
 * @example
 * ```ts
 * const index = getIndexBelow('a2' as IndexKey)
 * console.log(index) // 'a1'
 * ```
 * @public
 */
export declare function getIndexBelow(above?: IndexKey | null | undefined): IndexKey;
/**
 * Get n number of indices, starting at an index.
 * @param n - The number of indices to get.
 * @param start - The index to start at.
 * @returns An array containing the start index plus n additional IndexKey values.
 * @example
 * ```ts
 * const indices = getIndices(3, 'a1' as IndexKey)
 * console.log(indices) // ['a1', 'a2', 'a3', 'a4']
 * ```
 * @public
 */
export declare function getIndices(n: number, start?: IndexKey): IndexKey[];
/**
 * Sort by index.
 * @param a - An object with an index property.
 * @param b - An object with an index property.
 * @returns A number indicating sort order (-1, 0, or 1).
 * @example
 * ```ts
 * const shapes = [
 *   { id: 'b', index: 'a2' as IndexKey },
 *   { id: 'a', index: 'a1' as IndexKey }
 * ]
 * const sorted = shapes.sort(sortByIndex)
 * console.log(sorted) // [{ id: 'a', index: 'a1' }, { id: 'b', index: 'a2' }]
 * ```
 * @public
 */
export declare function sortByIndex<T extends {
    index: IndexKey;
}>(a: T, b: T): -1 | 0 | 1;
/**
 * Sort by index, or null.
 * @param a - An object with an index property.
 * @param b - An object with an index property.
 * @public
 */
export declare function sortByMaybeIndex<T extends {
    index?: IndexKey | null;
}>(a: T, b: T): -1 | 0 | 1;
//# sourceMappingURL=reordering.d.ts.map