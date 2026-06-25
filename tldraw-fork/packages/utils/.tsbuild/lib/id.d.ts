/*!
 * MIT License: https://github.com/ai/nanoid/blob/main/LICENSE
 * Modified code originally from <https://github.com/ai/nanoid>
 * Copyright 2017 Andrey Sitnik <andrey@sitnik.ru>
 *
 * `nanoid` is currently only distributed as an ES module. Some tools (jest, playwright) don't
 * properly support ESM-only code yet, and tldraw itself is distributed as both an ES module and a
 * CommonJS module. By including nanoid here, we can make sure it works well in every environment
 * where tldraw is used. We can also remove some unused features like custom alphabets.
 */
/**
 * Mock the unique ID generator with a custom implementation for testing.
 *
 * Replaces the internal ID generation function with a custom one. This is useful
 * for testing scenarios where you need predictable or deterministic IDs.
 *
 * @param fn - The mock function that should return a string ID. Takes optional size parameter.
 * @example
 * ```ts
 * // Mock with predictable IDs for testing
 * mockUniqueId((size = 21) => 'test-id-' + size)
 * console.log(uniqueId()) // 'test-id-21'
 * console.log(uniqueId(10)) // 'test-id-10'
 *
 * // Restore original implementation when done
 * restoreUniqueId()
 * ```
 * @internal
 */
export declare function mockUniqueId(fn: (size?: number) => string): void;
/**
 * Restore the original unique ID generator after mocking.
 *
 * Resets the ID generation function back to the original nanoid implementation.
 * This should be called after testing to restore normal ID generation behavior.
 *
 * @example
 * ```ts
 * // After mocking for tests
 * mockUniqueId(() => 'mock-id')
 *
 * // Restore original behavior
 * restoreUniqueId()
 * console.log(uniqueId()) // Now generates real random IDs again
 * ```
 * @internal
 */
export declare function restoreUniqueId(): void;
/**
 * Generate a unique ID using a modified nanoid algorithm.
 *
 * Generates a cryptographically secure random string ID using URL-safe characters.
 * The default size is 21 characters, which provides a good balance of uniqueness
 * and brevity. Uses the global crypto API for secure random number generation.
 *
 * @param size - Optional length of the generated ID (defaults to 21 characters)
 * @returns A unique string identifier
 * @example
 * ```ts
 * // Generate default 21-character ID
 * const id = uniqueId()
 * console.log(id) // 'V1StGXR8_Z5jdHi6B-myT'
 *
 * // Generate shorter ID
 * const shortId = uniqueId(10)
 * console.log(shortId) // 'V1StGXR8_Z'
 *
 * // Generate longer ID
 * const longId = uniqueId(32)
 * console.log(longId) // 'V1StGXR8_Z5jdHi6B-myTVKahvjdx...'
 * ```
 * @public
 */
export declare function uniqueId(size?: number): string;
//# sourceMappingURL=id.d.ts.map