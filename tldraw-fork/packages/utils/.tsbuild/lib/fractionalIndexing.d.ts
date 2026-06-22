/**
 * Throws if `key` is not a canonical order key. Allocation-free in the common
 * case: no `repeat`/`slice` per call.
 */
export declare function validateOrderKey(key: string): void;
/**
 * Generate `n` jittered keys evenly spaced between `a` and `b`. Inputs are
 * validated once; everything downstream is generated, hence trusted.
 */
export declare function generateNJitteredKeysBetween(a: string | null, b: string | null, n: number): string[];
/**
 * Generate `n` keys evenly spaced between `a` and `b`, without jitter. Used in
 * tests for deterministic output.
 */
export declare function generateNKeysBetween(a: string | null, b: string | null, n: number): string[];
//# sourceMappingURL=fractionalIndexing.d.ts.map