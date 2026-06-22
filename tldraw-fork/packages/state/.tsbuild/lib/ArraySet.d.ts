/**
 * The maximum number of items that can be stored in an ArraySet in array mode before switching to Set mode.
 *
 * @public
 * @example
 * ```ts
 * import { ARRAY_SIZE_THRESHOLD } from '@tldraw/state'
 *
 * console.log(ARRAY_SIZE_THRESHOLD) // 8
 * ```
 */
export declare const ARRAY_SIZE_THRESHOLD = 8;
/**
 * An ArraySet operates as an array until it reaches a certain size, after which a Set is used
 * instead. In either case, the same methods are used to get, set, remove, and visit the items.
 * @internal
 */
export declare class ArraySet<T> {
    private arraySize;
    private array;
    private set;
    /**
     * Get whether this ArraySet has any elements.
     *
     * @returns True if this ArraySet has any elements, false otherwise.
     */
    get isEmpty(): boolean;
    /**
     * Add an element to the ArraySet if it is not already present.
     *
     * @param elem - The element to add to the set
     * @returns `true` if the element was added, `false` if it was already present
     * @example
     * ```ts
     * const arraySet = new ArraySet<string>()
     *
     * console.log(arraySet.add('hello')) // true
     * console.log(arraySet.add('hello')) // false (already exists)
     * ```
     */
    add(elem: T): boolean;
    /**
     * Remove an element from the ArraySet if it is present.
     *
     * @param elem - The element to remove from the set
     * @returns `true` if the element was removed, `false` if it was not present
     * @example
     * ```ts
     * const arraySet = new ArraySet<string>()
     * arraySet.add('hello')
     *
     * console.log(arraySet.remove('hello')) // true
     * console.log(arraySet.remove('hello')) // false (not present)
     * ```
     */
    remove(elem: T): boolean;
    /**
     * Execute a callback function for each element in the ArraySet.
     *
     * @param visitor - A function to call for each element in the set
     * @example
     * ```ts
     * const arraySet = new ArraySet<string>()
     * arraySet.add('hello')
     * arraySet.add('world')
     *
     * arraySet.visit((item) => {
     *   console.log(item) // 'hello', 'world'
     * })
     * ```
     */
    visit(visitor: (item: T) => void): void;
    /**
     * Make the ArraySet iterable, allowing it to be used in for...of loops and with spread syntax.
     *
     * @returns An iterator that yields each element in the set
     * @example
     * ```ts
     * const arraySet = new ArraySet<number>()
     * arraySet.add(1)
     * arraySet.add(2)
     *
     * for (const item of arraySet) {
     *   console.log(item) // 1, 2
     * }
     *
     * const items = [...arraySet] // [1, 2]
     * ```
     */
    [Symbol.iterator](): Generator<T, void, unknown>;
    /**
     * Check whether an element is present in the ArraySet.
     *
     * @param elem - The element to check for
     * @returns `true` if the element is present, `false` otherwise
     * @example
     * ```ts
     * const arraySet = new ArraySet<string>()
     * arraySet.add('hello')
     *
     * console.log(arraySet.has('hello')) // true
     * console.log(arraySet.has('world')) // false
     * ```
     */
    has(elem: T): boolean;
    /**
     * Remove all elements from the ArraySet.
     *
     * @example
     * ```ts
     * const arraySet = new ArraySet<string>()
     * arraySet.add('hello')
     * arraySet.add('world')
     *
     * arraySet.clear()
     * console.log(arraySet.size()) // 0
     * ```
     */
    clear(): void;
    /**
     * Get the number of elements in the ArraySet.
     *
     * @returns The number of elements in the set
     * @example
     * ```ts
     * const arraySet = new ArraySet<string>()
     * console.log(arraySet.size()) // 0
     *
     * arraySet.add('hello')
     * console.log(arraySet.size()) // 1
     * ```
     */
    size(): number;
}
//# sourceMappingURL=ArraySet.d.ts.map