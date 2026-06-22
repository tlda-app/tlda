/**
 * Get a value from local storage.
 *
 * @param key - The key to get.
 * @returns The stored value as a string, or null if not found or storage is unavailable.
 * @example
 * ```ts
 * const userTheme = getFromLocalStorage('user-theme')
 * if (userTheme) {
 *   console.log('Stored theme:', userTheme)
 * }
 * ```
 * @internal
 */
export declare function getFromLocalStorage(key: string): string | null;
/**
 * Set a value in local storage. Will not throw an error if localStorage is not available.
 *
 * @param key - The key to set.
 * @param value - The value to set.
 * @returns void
 * @example
 * ```ts
 * const preferences = { theme: 'dark', language: 'en' }
 * setInLocalStorage('user-preferences', JSON.stringify(preferences))
 * ```
 * @internal
 */
export declare function setInLocalStorage(key: string, value: string): void;
/**
 * Remove a value from local storage. Will not throw an error if localStorage is not available.
 *
 * @param key - The key to remove.
 * @returns void
 * @example
 * ```ts
 * deleteFromLocalStorage('user-preferences')
 * // Value is now removed from localStorage
 * ```
 * @internal
 */
export declare function deleteFromLocalStorage(key: string): void;
/**
 * Clear all values from local storage. Will not throw an error if localStorage is not available.
 *
 * @returns void
 * @example
 * ```ts
 * clearLocalStorage()
 * // All localStorage data is now cleared
 * ```
 * @internal
 */
export declare function clearLocalStorage(): void;
/**
 * Get a value from session storage.
 *
 * @param key - The key to get.
 * @returns The stored value as a string, or null if not found or storage is unavailable.
 * @example
 * ```ts
 * const currentTool = getFromSessionStorage('current-tool')
 * if (currentTool) {
 *   console.log('Active tool:', currentTool)
 * }
 * ```
 * @internal
 */
export declare function getFromSessionStorage(key: string): string | null;
/**
 * Set a value in session storage. Will not throw an error if sessionStorage is not available.
 *
 * @param key - The key to set.
 * @param value - The value to set.
 * @returns void
 * @example
 * ```ts
 * setInSessionStorage('current-tool', 'select')
 * setInSessionStorage('temp-data', JSON.stringify({ x: 100, y: 200 }))
 * ```
 * @internal
 */
export declare function setInSessionStorage(key: string, value: string): void;
/**
 * Remove a value from session storage. Will not throw an error if sessionStorage is not available.
 *
 * @param key - The key to remove.
 * @returns void
 * @example
 * ```ts
 * deleteFromSessionStorage('temp-data')
 * // Value is now removed from sessionStorage
 * ```
 * @internal
 */
export declare function deleteFromSessionStorage(key: string): void;
/**
 * Clear all values from session storage. Will not throw an error if sessionStorage is not available.
 *
 * @returns void
 * @example
 * ```ts
 * clearSessionStorage()
 * // All sessionStorage data is now cleared
 * ```
 * @internal
 */
export declare function clearSessionStorage(): void;
//# sourceMappingURL=storage.d.ts.map