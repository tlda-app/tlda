import { Atom, Computed } from '@tldraw/state';
import { AtomMap } from './AtomMap';
import { IdOf, UnknownRecord } from './BaseRecord';
import { QueryExpression } from './executeQuery';
import { RecordsDiff } from './RecordsDiff';
import { CollectionDiff } from './Store';
/**
 * A type representing the diff of changes to a reactive store index.
 * Maps property values to the collection differences for record IDs that have that property value.
 *
 * @example
 * ```ts
 * // For an index on book titles, the diff might look like:
 * const titleIndexDiff: RSIndexDiff<Book, 'title'> = new Map([
 *   ['The Lathe of Heaven', { added: new Set(['book:1']), removed: new Set() }],
 *   ['Animal Farm', { added: new Set(), removed: new Set(['book:2']) }]
 * ])
 * ```
 *
 * @public
 */
export type RSIndexDiff<R extends UnknownRecord> = Map<any, CollectionDiff<IdOf<R>>>;
/**
 * A type representing a reactive store index as a map from property values to sets of record IDs.
 * This is used to efficiently look up records by a specific property value.
 *
 * @example
 * ```ts
 * // Index mapping book titles to the IDs of books with that title
 * const titleIndex: RSIndexMap<Book, 'title'> = new Map([
 *   ['The Lathe of Heaven', new Set(['book:1'])],
 *   ['Animal Farm', new Set(['book:2', 'book:3'])]
 * ])
 * ```
 *
 * @public
 */
export type RSIndexMap<R extends UnknownRecord> = Map<any, Set<IdOf<R>>>;
/**
 * A reactive computed index that provides efficient lookups of records by property values.
 * Returns a computed value containing an RSIndexMap with diffs for change tracking.
 *
 * @example
 * ```ts
 * // Create an index on book authors
 * const authorIndex: RSIndex<Book, 'authorId'> = store.query.index('book', 'authorId')
 *
 * // Get all books by a specific author
 * const leguinBooks = authorIndex.get().get('author:leguin')
 * ```
 *
 * @public
 */
export type RSIndex<R extends UnknownRecord> = Computed<RSIndexMap<R>, RSIndexDiff<R>>;
/**
 * A class that provides reactive querying capabilities for a record store.
 * Offers methods to create indexes, filter records, and perform efficient lookups with automatic cache management.
 * All queries are reactive and will automatically update when the underlying store data changes.
 *
 * @example
 * ```ts
 * // Create a store with books
 * const store = new Store({ schema: StoreSchema.create({ book: Book, author: Author }) })
 *
 * // Get reactive queries for books
 * const booksByAuthor = store.query.index('book', 'authorId')
 * const inStockBooks = store.query.records('book', () => ({ inStock: { eq: true } }))
 * ```
 *
 * @public
 */
export declare class StoreQueries<R extends UnknownRecord> {
    private readonly recordMap;
    private readonly history;
    /**
     * Creates a new StoreQueries instance.
     *
     * recordMap - The atom map containing all records in the store
     * history - The atom tracking the store's change history with diffs
     *
     * @internal
     */
    constructor(recordMap: AtomMap<IdOf<R>, R>, history: Atom<number, RecordsDiff<R>>);
    /**
     * A cache of derivations (indexes).
     *
     * @internal
     */
    private indexCache;
    /**
     * A cache of derivations (filtered histories).
     *
     * @internal
     */
    private historyCache;
    /**
     * @internal
     */
    getAllIdsForType<TypeName extends R['typeName']>(typeName: TypeName): Set<IdOf<Extract<R, {
        typeName: TypeName;
    }>>>;
    /**
     * @internal
     */
    getRecordById<TypeName extends R['typeName']>(typeName: TypeName, id: IdOf<Extract<R, {
        typeName: TypeName;
    }>>): Extract<R, {
        typeName: TypeName;
    }> | undefined;
    /**
     * Helper to extract nested property value using pre-split path parts.
     * @internal
     */
    private getNestedValue;
    /**
     * Creates a reactive computed that tracks the change history for records of a specific type.
     * The returned computed provides incremental diffs showing what records of the given type
     * have been added, updated, or removed.
     *
     * @param typeName - The type name to filter the history by
     * @returns A computed value containing the current epoch and diffs of changes for the specified type
     *
     * @example
     * ```ts
     * // Track changes to book records only
     * const bookHistory = store.query.filterHistory('book')
     *
     * // React to book changes
     * react('book-changes', () => {
     *   const currentEpoch = bookHistory.get()
     *   console.log('Books updated at epoch:', currentEpoch)
     * })
     * ```
     *
     * @public
     */
    filterHistory<TypeName extends R['typeName']>(typeName: TypeName): Computed<number, RecordsDiff<Extract<R, {
        typeName: TypeName;
    }>>>;
    /**
     * Creates a reactive index that maps property values to sets of record IDs for efficient lookups.
     * The index automatically updates when records are added, updated, or removed, and results are cached
     * for performance.
     *
     * Supports nested property paths using backslash separator (e.g., 'metadata\\sessionId').
     *
     * @param typeName - The type name of records to index
     * @param path - The property name or backslash-delimited path to index by
     * @returns A reactive computed containing the index map with change diffs
     *
     * @example
     * ```ts
     * // Create an index of books by author ID
     * const booksByAuthor = store.query.index('book', 'authorId')
     *
     * // Get all books by a specific author
     * const authorBooks = booksByAuthor.get().get('author:leguin')
     * console.log(authorBooks) // Set<RecordId<Book>>
     *
     * // Index by nested property using backslash separator
     * const booksBySession = store.query.index('book', 'metadata\\sessionId')
     * const sessionBooks = booksBySession.get().get('session:alpha')
     * ```
     *
     * @public
     */
    index<TypeName extends R['typeName']>(typeName: TypeName, path: string): RSIndex<Extract<R, {
        typeName: TypeName;
    }>>;
    /**
     * Creates a new index without checking the cache. This method performs the actual work
     * of building the reactive index computation that tracks property values to record ID sets.
     *
     * Supports nested property paths using backslash separator.
     *
     * @param typeName - The type name of records to index
     * @param path - The property name or backslash-delimited path to index by
     * @returns A reactive computed containing the index map with change diffs
     *
     * @internal
     */
    __uncached_createIndex<TypeName extends R['typeName']>(typeName: TypeName, path: string): RSIndex<Extract<R, {
        typeName: TypeName;
    }>>;
    /**
     * Creates a reactive query that returns the first record matching the given query criteria.
     * Returns undefined if no matching record is found. The query automatically updates
     * when records change.
     *
     * @param typeName - The type name of records to query
     * @param queryCreator - Function that returns the query expression object to match against
     * @param name - Optional name for the query computation (used for debugging)
     * @returns A computed value containing the first matching record or undefined
     *
     * @example
     * ```ts
     * // Find the first book with a specific title
     * const bookLatheOfHeaven = store.query.record('book', () => ({ title: { eq: 'The Lathe of Heaven' } }))
     * console.log(bookLatheOfHeaven.get()?.title) // 'The Lathe of Heaven' or undefined
     *
     * // Find any book in stock
     * const anyInStockBook = store.query.record('book', () => ({ inStock: { eq: true } }))
     * ```
     *
     * @public
     */
    record<TypeName extends R['typeName']>(typeName: TypeName, queryCreator?: () => QueryExpression<Extract<R, {
        typeName: TypeName;
    }>>, name?: string): Computed<Extract<R, {
        typeName: TypeName;
    }> | undefined>;
    /**
     * Creates a reactive query that returns an array of all records matching the given query criteria.
     * The array automatically updates when records are added, updated, or removed.
     *
     * @param typeName - The type name of records to query
     * @param queryCreator - Function that returns the query expression object to match against
     * @param name - Optional name for the query computation (used for debugging)
     * @returns A computed value containing an array of all matching records
     *
     * @example
     * ```ts
     * // Get all books in stock
     * const inStockBooks = store.query.records('book', () => ({ inStock: { eq: true } }))
     * console.log(inStockBooks.get()) // Book[]
     *
     * // Get all books by a specific author
     * const leguinBooks = store.query.records('book', () => ({ authorId: { eq: 'author:leguin' } }))
     *
     * // Get all books (no filter)
     * const allBooks = store.query.records('book')
     * ```
     *
     * @public
     */
    records<TypeName extends R['typeName']>(typeName: TypeName, queryCreator?: () => QueryExpression<Extract<R, {
        typeName: TypeName;
    }>>, name?: string): Computed<Array<Extract<R, {
        typeName: TypeName;
    }>>>;
    /**
     * Creates a reactive query that returns a set of record IDs matching the given query criteria.
     * This is more efficient than `records()` when you only need the IDs and not the full record objects.
     * The set automatically updates with collection diffs when records change.
     *
     * @param typeName - The type name of records to query
     * @param queryCreator - Function that returns the query expression object to match against
     * @param name - Optional name for the query computation (used for debugging)
     * @returns A computed value containing a set of matching record IDs with collection diffs
     *
     * @example
     * ```ts
     * // Get IDs of all books in stock
     * const inStockBookIds = store.query.ids('book', () => ({ inStock: { eq: true } }))
     * console.log(inStockBookIds.get()) // Set<RecordId<Book>>
     *
     * // Get all book IDs (no filter)
     * const allBookIds = store.query.ids('book')
     *
     * // Use with other queries for efficient lookups
     * const authorBookIds = store.query.ids('book', () => ({ authorId: { eq: 'author:leguin' } }))
     * ```
     *
     * @public
     */
    ids<TypeName extends R['typeName']>(typeName: TypeName, queryCreator?: () => QueryExpression<Extract<R, {
        typeName: TypeName;
    }>>, name?: string): Computed<Set<IdOf<Extract<R, {
        typeName: TypeName;
    }>>>, CollectionDiff<IdOf<Extract<R, {
        typeName: TypeName;
    }>>>>;
    /**
     * Executes a one-time query against the current store state and returns matching records.
     * This is a non-reactive query that returns results immediately without creating a computed value.
     * Use this when you need a snapshot of data at a specific point in time.
     *
     * @param typeName - The type name of records to query
     * @param query - The query expression object to match against
     * @returns An array of records that match the query at the current moment
     *
     * @example
     * ```ts
     * // Get current in-stock books (non-reactive)
     * const currentInStockBooks = store.query.exec('book', { inStock: { eq: true } })
     * console.log(currentInStockBooks) // Book[]
     *
     * // Unlike records(), this won't update when the data changes
     * const staticBookList = store.query.exec('book', { authorId: { eq: 'author:leguin' } })
     * ```
     *
     * @public
     */
    exec<TypeName extends R['typeName']>(typeName: TypeName, query: QueryExpression<Extract<R, {
        typeName: TypeName;
    }>>): Array<Extract<R, {
        typeName: TypeName;
    }>>;
}
//# sourceMappingURL=StoreQueries.d.ts.map