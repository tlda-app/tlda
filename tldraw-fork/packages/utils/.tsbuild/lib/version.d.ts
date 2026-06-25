/**
 * Clears all registered library versions and resets warning state.
 * This function is intended for testing purposes only to reset the global version tracking state.
 * @returns void
 * @example
 * ```ts
 * // In a test setup
 * beforeEach(() => {
 *   clearRegisteredVersionsForTests()
 * })
 *
 * // Now version tracking starts fresh for each test
 * registerTldrawLibraryVersion('@tldraw/editor', '2.0.0', 'esm')
 * ```
 * @internal
 */
export declare function clearRegisteredVersionsForTests(): void;
/**
 * Registers a tldraw library version for conflict detection.
 * This function tracks different tldraw library versions to warn about potential conflicts
 * when multiple versions are loaded simultaneously.
 * @param name - The name of the tldraw library package (e.g., '\@tldraw/editor').
 * @param version - The semantic version string (e.g., '2.0.0').
 * @param modules - The module system being used ('esm' or 'cjs').
 * @returns void
 * @example
 * ```ts
 * // Register a library version during package initialization
 * registerTldrawLibraryVersion('@tldraw/editor', '2.0.0', 'esm')
 * registerTldrawLibraryVersion('@tldraw/tldraw', '2.0.0', 'esm')
 *
 * // If conflicting versions are detected, warnings will be logged:
 * registerTldrawLibraryVersion('@tldraw/editor', '1.9.0', 'cjs')
 * // Console warning about version mismatch will appear
 * ```
 * @internal
 */
export declare function registerTldrawLibraryVersion(name?: string, version?: string, modules?: string): void;
//# sourceMappingURL=version.d.ts.map