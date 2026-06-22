/**
 * Safely checks if an object has a specific property as its own property (not inherited).
 * Uses Object.prototype.hasOwnProperty.call to avoid issues with objects that have null prototype
 * or have overridden the hasOwnProperty method.
 *
 * @param obj - The object to check
 * @param key - The property key to check for
 * @returns True if the object has the property as its own property, false otherwise
 * @example
 * ```ts
 * const obj = { name: 'Alice', age: 30 }
 * hasOwnProperty(obj, 'name') // true
 * hasOwnProperty(obj, 'toString') // false (inherited)
 * hasOwnProperty(obj, 'unknown') // false
 * ```
 * @internal
 */
export declare function hasOwnProperty(obj: object, key: string): boolean;
/**
 * Safely gets an object's own property value (not inherited). Returns undefined if the property
 * doesn't exist as an own property. Provides type-safe access with proper TypeScript inference.
 *
 * @param obj - The object to get the property from
 * @param key - The property key to retrieve
 * @returns The property value if it exists as an own property, undefined otherwise
 * @example
 * ```ts
 * const user = { name: 'Alice', age: 30 }
 * const name = getOwnProperty(user, 'name') // 'Alice'
 * const missing = getOwnProperty(user, 'unknown') // undefined
 * const inherited = getOwnProperty(user, 'toString') // undefined (inherited)
 * ```
 * @internal
 */
export declare function getOwnProperty<K extends string, V>(obj: Partial<Record<K, V>>, key: K): V | undefined;
/** @internal */
export declare function getOwnProperty<O extends object>(obj: O, key: string): O[keyof O] | undefined;
/** @internal */
export declare function getOwnProperty(obj: object, key: string): unknown;
/**
 * An alias for `Object.keys` that treats the object as a map and so preserves the type of the keys.
 * Unlike standard Object.keys which returns string[], this maintains the specific string literal types.
 *
 * @param object - The object to get keys from
 * @returns Array of keys with preserved string literal types
 * @example
 * ```ts
 * const config = { theme: 'dark', lang: 'en' } as const
 * const keys = objectMapKeys(config)
 * // keys is Array<'theme' | 'lang'> instead of string[]
 * ```
 * @internal
 */
export declare function objectMapKeys<Key extends string>(object: {
    readonly [K in Key]: unknown;
}): Array<Key>;
/**
 * An alias for `Object.values` that treats the object as a map and so preserves the type of the
 * values. Unlike standard Object.values which returns unknown[], this maintains the specific value types.
 *
 * @param object - The object to get values from
 * @returns Array of values with preserved types
 * @example
 * ```ts
 * const scores = { alice: 85, bob: 92, charlie: 78 }
 * const values = objectMapValues(scores)
 * // values is Array<number> instead of unknown[]
 * ```
 * @internal
 */
export declare function objectMapValues<Key extends string, Value>(object: {
    [K in Key]: Value;
}): Array<Value>;
/**
 * An alias for `Object.entries` that treats the object as a map and so preserves the type of the
 * keys and values. Unlike standard Object.entries which returns `Array<[string, unknown]>`, this maintains specific types.
 *
 * @param object - The object to get entries from
 * @returns Array of key-value pairs with preserved types
 * @example
 * ```ts
 * const user = { name: 'Alice', age: 30 }
 * const entries = objectMapEntries(user)
 * // entries is Array<['name' | 'age', string | number]>
 * ```
 * @internal
 */
export declare function objectMapEntries<Obj extends object>(object: Obj): Array<[keyof Obj, Obj[keyof Obj]]>;
/**
 * Returns the entries of an object as an iterable iterator.
 * Useful when working with large collections, to avoid allocating an array.
 * Only yields own properties (not inherited ones).
 *
 * @param object - The object to iterate over
 * @returns Iterator yielding key-value pairs with preserved types
 * @example
 * ```ts
 * const largeMap = { a: 1, b: 2, c: 3 } // Imagine thousands of entries
 * for (const [key, value] of objectMapEntriesIterable(largeMap)) {
 *   // Process entries one at a time without creating a large array
 *   console.log(key, value)
 * }
 * ```
 * @internal
 */
export declare function objectMapEntriesIterable<Key extends string, Value>(object: {
    [K in Key]: Value;
}): IterableIterator<[Key, Value]>;
/**
 * An alias for `Object.fromEntries` that treats the object as a map and so preserves the type of the
 * keys and values. Creates an object from key-value pairs with proper TypeScript typing.
 *
 * @param entries - Array of key-value pairs to convert to an object
 * @returns Object with preserved key and value types
 * @example
 * ```ts
 * const pairs: Array<['name' | 'age', string | number]> = [['name', 'Alice'], ['age', 30]]
 * const obj = objectMapFromEntries(pairs)
 * // obj is { name: string | number, age: string | number }
 * ```
 * @internal
 */
export declare function objectMapFromEntries<Key extends string, Value>(entries: ReadonlyArray<readonly [Key, Value]>): {
    [K in Key]: Value;
};
/**
 * Filters an object using a predicate function, returning a new object with only the entries
 * that pass the predicate. Optimized to return the original object if no changes are needed.
 *
 * @param object - The object to filter
 * @param predicate - Function that tests each key-value pair
 * @returns A new object with only the entries that pass the predicate, or the original object if unchanged
 * @example
 * ```ts
 * const scores = { alice: 85, bob: 92, charlie: 78 }
 * const passing = filterEntries(scores, (name, score) => score >= 80)
 * // { alice: 85, bob: 92 }
 * ```
 * @internal
 */
export declare function filterEntries<Key extends string, Value>(object: {
    [K in Key]: Value;
}, predicate: (key: Key, value: Value) => boolean): {
    [K in Key]: Value;
};
/**
 * Maps the values of an object to new values using a mapper function, preserving keys.
 * The mapper function receives both the key and value for each entry.
 *
 * @param object - The object whose values to transform
 * @param mapper - Function that transforms each value (receives key and value)
 * @returns A new object with the same keys but transformed values
 * @example
 * ```ts
 * const prices = { apple: 1.50, banana: 0.75, orange: 2.00 }
 * const withTax = mapObjectMapValues(prices, (fruit, price) => price * 1.08)
 * // { apple: 1.62, banana: 0.81, orange: 2.16 }
 * ```
 * @internal
 */
export declare function mapObjectMapValues<Key extends string, ValueBefore, ValueAfter>(object: {
    readonly [K in Key]: ValueBefore;
}, mapper: (key: Key, value: ValueBefore) => ValueAfter): {
    [K in Key]: ValueAfter;
};
/**
 * Performs a shallow equality check between two objects. Compares all enumerable own properties
 * using Object.is for value comparison. Returns true if both objects have the same keys and values.
 *
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @returns True if objects are shallow equal, false otherwise
 * @example
 * ```ts
 * const a = { x: 1, y: 2 }
 * const b = { x: 1, y: 2 }
 * const c = { x: 1, y: 3 }
 * areObjectsShallowEqual(a, b) // true
 * areObjectsShallowEqual(a, c) // false
 * areObjectsShallowEqual(a, a) // true (same reference)
 * ```
 * @internal
 */
export declare function areObjectsShallowEqual<T extends object>(obj1: T, obj2: T): boolean;
/**
 * Groups an array of values into a record by a key extracted from each value.
 * The key selector function is called for each element to determine the grouping key.
 *
 * @param array - The array to group
 * @param keySelector - Function that extracts the grouping key from each value
 * @returns A record where keys are the extracted keys and values are arrays of grouped items
 * @example
 * ```ts
 * const people = [
 *   { name: 'Alice', age: 25 },
 *   { name: 'Bob', age: 30 },
 *   { name: 'Charlie', age: 25 }
 * ]
 * const byAge = groupBy(people, person => `age-${person.age}`)
 * // { 'age-25': [Alice, Charlie], 'age-30': [Bob] }
 * ```
 * @internal
 */
export declare function groupBy<K extends string, V>(array: ReadonlyArray<V>, keySelector: (value: V) => K): Record<K, V[]>;
/**
 * Creates a new object with specified keys omitted from the original object.
 * Uses shallow copying and then deletes the unwanted keys.
 *
 * @param obj - The source object
 * @param keys - Array of key names to omit from the result
 * @returns A new object without the specified keys
 * @example
 * ```ts
 * const user = { id: '123', name: 'Alice', password: 'secret', email: 'alice@example.com' }
 * const publicUser = omit(user, ['password'])
 * // { id: '123', name: 'Alice', email: 'alice@example.com' }
 * ```
 * @internal
 */
export declare function omit(obj: Record<string, unknown>, keys: ReadonlyArray<string>): Record<string, unknown>;
/**
 * Compares two objects and returns an array of keys where the values differ.
 * Uses Object.is for comparison, which handles NaN and -0/+0 correctly.
 * Only checks keys present in the first object.
 *
 * @param obj1 - The first object (keys to check come from this object)
 * @param obj2 - The second object to compare against
 * @returns Array of keys where values differ between the objects
 * @example
 * ```ts
 * const before = { name: 'Alice', age: 25, city: 'NYC' }
 * const after = { name: 'Alice', age: 26, city: 'NYC' }
 * const changed = getChangedKeys(before, after)
 * // ['age']
 * ```
 * @internal
 */
export declare function getChangedKeys<T extends object>(obj1: T, obj2: T): (keyof T)[];
/**
 * Deep equality comparison that allows for floating-point precision errors.
 * Numbers are considered equal if they differ by less than the threshold.
 * Uses lodash.isequalwith internally for the deep comparison logic.
 *
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @param threshold - Maximum difference allowed between numbers (default: 0.000001)
 * @returns True if objects are deeply equal with floating-point tolerance
 * @example
 * ```ts
 * const a = { x: 0.1 + 0.2 } // 0.30000000000000004
 * const b = { x: 0.3 }
 * isEqualAllowingForFloatingPointErrors(a, b) // true
 *
 * const c = { coords: [1.0000001, 2.0000001] }
 * const d = { coords: [1.0000002, 2.0000002] }
 * isEqualAllowingForFloatingPointErrors(c, d) // true
 * ```
 * @internal
 */
export declare function isEqualAllowingForFloatingPointErrors(obj1: object, obj2: object, threshold?: number): boolean;
//# sourceMappingURL=object.d.ts.map