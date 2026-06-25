interface Ref {
    value: boolean;
}
declare class OwnerID {
}
/**
 * A persistent immutable map implementation based on a Hash Array Mapped Trie (HAMT) data structure.
 * Provides efficient operations for creating, reading, updating, and deleting key-value pairs while
 * maintaining structural sharing to minimize memory usage and maximize performance.
 *
 * This implementation is extracted and adapted from Immutable.js, optimized for tldraw's store needs.
 * All operations return new instances rather than modifying existing ones, ensuring immutability.
 *
 * @public
 * @example
 * ```ts
 * // Create a new map
 * const map = new ImmutableMap([
 *   ['key1', 'value1'],
 *   ['key2', 'value2']
 * ])
 *
 * // Add or update values
 * const updated = map.set('key3', 'value3')
 *
 * // Get values
 * const value = map.get('key1') // 'value1'
 *
 * // Delete values
 * const smaller = map.delete('key1')
 * ```
 */
export declare class ImmutableMap<K, V> {
    _root: MapNode<K, V>;
    size: number;
    __ownerID: OwnerID;
    __hash: number | undefined;
    __altered: boolean;
    /**
     * Creates a new ImmutableMap instance.
     *
     * @param value - An iterable of key-value pairs to populate the map, or null/undefined for an empty map
     * @example
     * ```ts
     * // Create from array of pairs
     * const map1 = new ImmutableMap([['a', 1], ['b', 2]])
     *
     * // Create empty map
     * const map2 = new ImmutableMap()
     *
     * // Create from another map
     * const map3 = new ImmutableMap(map1)
     * ```
     */
    constructor(value?: Iterable<[K, V]> | null | undefined);
    /**
     * Gets the value associated with the specified key.
     *
     * @param k - The key to look up
     * @returns The value associated with the key, or undefined if not found
     * @example
     * ```ts
     * const map = new ImmutableMap([['key1', 'value1']])
     * console.log(map.get('key1')) // 'value1'
     * console.log(map.get('missing')) // undefined
     * ```
     */
    get(k: K): V | undefined;
    /**
     * Gets the value associated with the specified key, with a fallback value.
     *
     * @param k - The key to look up
     * @param notSetValue - The value to return if the key is not found
     * @returns The value associated with the key, or the fallback value if not found
     * @example
     * ```ts
     * const map = new ImmutableMap([['key1', 'value1']])
     * console.log(map.get('key1', 'default')) // 'value1'
     * console.log(map.get('missing', 'default')) // 'default'
     * ```
     */
    get(k: K, notSetValue: V): V;
    /**
     * Returns a new ImmutableMap with the specified key-value pair added or updated.
     * If the key already exists, its value is replaced. Otherwise, a new entry is created.
     *
     * @param k - The key to set
     * @param v - The value to associate with the key
     * @returns A new ImmutableMap with the key-value pair set
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1]])
     * const updated = map.set('b', 2) // New map with both 'a' and 'b'
     * const replaced = map.set('a', 10) // New map with 'a' updated to 10
     * ```
     */
    set(k: K, v: V): any;
    /**
     * Returns a new ImmutableMap with the specified key removed.
     * If the key doesn't exist, returns the same map instance.
     *
     * @param k - The key to remove
     * @returns A new ImmutableMap with the key removed, or the same instance if key not found
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1], ['b', 2]])
     * const smaller = map.delete('a') // New map with only 'b'
     * const same = map.delete('missing') // Returns original map
     * ```
     */
    delete(k: K): any;
    /**
     * Returns a new ImmutableMap with all specified keys removed.
     * This is more efficient than calling delete() multiple times.
     *
     * @param keys - An iterable of keys to remove
     * @returns A new ImmutableMap with all specified keys removed
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1], ['b', 2], ['c', 3]])
     * const smaller = map.deleteAll(['a', 'c']) // New map with only 'b'
     * ```
     */
    deleteAll(keys: Iterable<K>): this;
    __ensureOwner(ownerID: OwnerID): any;
    /**
     * Applies multiple mutations efficiently by creating a mutable copy,
     * applying all changes, then returning an immutable result.
     * This is more efficient than chaining multiple set/delete operations.
     *
     * @param fn - Function that receives a mutable copy and applies changes
     * @returns A new ImmutableMap with all mutations applied, or the same instance if no changes
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1]])
     * const updated = map.withMutations(mutable => {
     *   mutable.set('b', 2)
     *   mutable.set('c', 3)
     *   mutable.delete('a')
     * }) // Efficiently applies all changes at once
     * ```
     */
    withMutations(fn: (mutable: this) => void): this;
    /**
     * Checks if this map instance has been altered during a mutation operation.
     * This is used internally to optimize mutations.
     *
     * @returns True if the map was altered, false otherwise
     * @internal
     */
    wasAltered(): boolean;
    /**
     * Returns a mutable copy of this map that can be efficiently modified.
     * Multiple changes to the mutable copy are batched together.
     *
     * @returns A mutable copy of this map
     * @internal
     */
    asMutable(): any;
    /**
     * Makes the map iterable, yielding key-value pairs.
     *
     * @returns An iterator over [key, value] pairs
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1], ['b', 2]])
     * for (const [key, value] of map) {
     *   console.log(key, value) // 'a' 1, then 'b' 2
     * }
     * ```
     */
    [Symbol.iterator](): Iterator<[K, V]>;
    /**
     * Returns an iterable of key-value pairs.
     *
     * @returns An iterable over [key, value] pairs
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1], ['b', 2]])
     * const entries = Array.from(map.entries()) // [['a', 1], ['b', 2]]
     * ```
     */
    entries(): Iterable<[K, V]>;
    /**
     * Returns an iterable of keys.
     *
     * @returns An iterable over keys
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1], ['b', 2]])
     * const keys = Array.from(map.keys()) // ['a', 'b']
     * ```
     */
    keys(): Iterable<K>;
    /**
     * Returns an iterable of values.
     *
     * @returns An iterable over values
     * @example
     * ```ts
     * const map = new ImmutableMap([['a', 1], ['b', 2]])
     * const values = Array.from(map.values()) // [1, 2]
     * ```
     */
    values(): Iterable<V>;
}
type MapNode<K, V> = ArrayMapNode<K, V> | BitmapIndexedNode<K, V> | HashArrayMapNode<K, V> | HashCollisionNode<K, V> | ValueNode<K, V>;
declare class ArrayMapNode<K, V> {
    ownerID: OwnerID;
    entries: Array<[K, V]>;
    constructor(ownerID: OwnerID, entries: Array<[K, V]>);
    get(_shift: unknown, _keyHash: unknown, key: K, notSetValue?: V): V | undefined;
    update(ownerID: OwnerID, _shift: unknown, _keyHash: unknown, key: K, value: V, didChangeSize?: Ref, didAlter?: Ref): MapNode<K, V> | undefined;
}
declare class BitmapIndexedNode<K, V> {
    ownerID: OwnerID;
    bitmap: number;
    nodes: Array<MapNode<K, V>>;
    constructor(ownerID: OwnerID, bitmap: number, nodes: Array<MapNode<K, V>>);
    get(shift: number, keyHash: number, key: K, notSetValue?: V): V | undefined;
    update(ownerID: OwnerID, shift: number, keyHash: number, key: K, value: V, didChangeSize?: Ref, didAlter?: Ref): MapNode<K, V> | undefined;
}
declare class HashArrayMapNode<K, V> {
    ownerID: OwnerID;
    count: number;
    nodes: Array<MapNode<K, V>>;
    constructor(ownerID: OwnerID, count: number, nodes: Array<MapNode<K, V>>);
    get(shift: number, keyHash: number, key: K, notSetValue?: V): V | undefined;
    update(ownerID: OwnerID, shift: number, keyHash: number, key: K, value: V, didChangeSize?: Ref, didAlter?: Ref): BitmapIndexedNode<unknown, unknown> | HashArrayMapNode<K, V>;
}
declare class HashCollisionNode<K, V> {
    ownerID: OwnerID;
    keyHash: number;
    entries: Array<[K, V]>;
    constructor(ownerID: OwnerID, keyHash: number, entries: Array<[K, V]>);
    get(shift: number, keyHash: number, key: K, notSetValue?: V): V | undefined;
    update(ownerID: OwnerID, shift: number, keyHash: number, key: K, value: V, didChangeSize?: Ref, didAlter?: Ref): MapNode<K, V>;
}
declare class ValueNode<K, V> {
    ownerID: OwnerID;
    keyHash: number | undefined;
    entry: [K, V];
    constructor(ownerID: OwnerID, keyHash: number | undefined, entry: [K, V]);
    get(shift: number, keyHash: number, key: K, notSetValue?: V): V | undefined;
    update(ownerID: OwnerID, shift: number, keyHash: number | undefined, key: K, value: V, didChangeSize?: Ref, didAlter?: Ref): MapNode<K, V> | undefined;
}
/**
 * Creates a completed iterator result object indicating iteration is finished.
 * Used internally by map iterators to signal the end of iteration.
 *
 * @returns An IteratorResult object with done set to true and value as undefined
 * @public
 * @example
 * ```ts
 * // Used internally by iterators
 * const result = iteratorDone()
 * console.log(result) // { value: undefined, done: true }
 * ```
 */
export declare function iteratorDone(): {
    value: undefined;
    done: boolean;
};
/**
 * Returns a singleton empty ImmutableMap instance.
 * This function is optimized to return the same empty map instance for all calls,
 * saving memory when working with many empty maps.
 *
 * @returns An empty ImmutableMap instance
 * @public
 * @example
 * ```ts
 * // Get an empty map
 * const empty = emptyMap<string, number>()
 * console.log(empty.size) // 0
 *
 * // All empty maps are the same instance
 * const empty1 = emptyMap()
 * const empty2 = emptyMap()
 * console.log(empty1 === empty2) // true
 * ```
 */
export declare function emptyMap<K, V>(): ImmutableMap<K, V>;
export {};
//# sourceMappingURL=ImmutableMap.d.ts.map