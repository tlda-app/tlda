/**
 * A drop-in replacement for Set that stores values in atoms and can be used in reactive contexts.
 * @public
 */
export declare class AtomSet<T> {
    private readonly name;
    private readonly map;
    constructor(name: string, keys?: Iterable<T>);
    add(value: T): this;
    clear(): void;
    delete(value: T): boolean;
    forEach(callbackfn: (value: T, value2: T, set: AtomSet<T>) => void, thisArg?: any): void;
    has(value: T): boolean;
    get size(): number;
    entries(): Generator<[T, T], undefined, unknown>;
    keys(): Generator<T, undefined, unknown>;
    values(): Generator<T, undefined, unknown>;
    [Symbol.iterator](): Generator<T, undefined, unknown>;
    [Symbol.toStringTag]: string;
}
//# sourceMappingURL=AtomSet.d.ts.map