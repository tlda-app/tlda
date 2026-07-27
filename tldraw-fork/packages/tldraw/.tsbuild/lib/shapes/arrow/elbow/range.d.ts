export interface Range {
    min: number;
    max: number;
}
export declare function expandRange(range: Range, amount: number): Range | null;
export declare function clampToRange(value: number, range: Range): number;
/**
 * Subtract the range b from the range a. If b is completely inside a, return the two ranges of a
 * that are outside of b. If b contains a, return []. Otherwise, return the range of a that is
 * outside of b.
 */
export declare function subtractRange(a: Range, b: Range): [] | [Range] | [Range, Range];
export declare function createRange(a: number, b: number): {
    min: number;
    max: number;
};
export declare function doRangesOverlap(a: Range, b: Range): boolean;
export declare function isWithinRange(value: number, range: Range): boolean;
export declare function rangeSize(range: Range): number;
export declare function rangeCenter(range: Range): number;
//# sourceMappingURL=range.d.ts.map