/** Simple LRU cache backed by a Map's insertion-order iteration. @public */
export declare class LruCache<K, V> {
    private maxSize;
    private map;
    constructor(maxSize: number);
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    has(key: K): boolean;
    get size(): number;
}
//# sourceMappingURL=LruCache.d.ts.map