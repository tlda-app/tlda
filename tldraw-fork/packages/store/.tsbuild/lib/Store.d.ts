import { Atom, Signal } from '@tldraw/state';
import { IdOf, RecordId, UnknownRecord } from './BaseRecord';
import { RecordsDiff } from './RecordsDiff';
import { RecordScope } from './RecordType';
import { StoreQueries } from './StoreQueries';
import { SerializedSchema, StoreSchema } from './StoreSchema';
import { StoreSideEffects } from './StoreSideEffects';
/**
 * Extracts the record type from a record ID type.
 *
 * @example
 * ```ts
 * type BookId = RecordId<Book>
 * type BookType = RecordFromId<BookId> // Book
 * ```
 *
 * @public
 */
export type RecordFromId<K extends RecordId<UnknownRecord>> = K extends RecordId<infer R> ? R : never;
/**
 * A diff describing the changes to a collection.
 *
 * @example
 * ```ts
 * const diff: CollectionDiff<string> = {
 *   added: new Set(['newItem']),
 *   removed: new Set(['oldItem'])
 * }
 * ```
 *
 * @public
 */
export interface CollectionDiff<T> {
    /** Items that were added to the collection */
    added?: Set<T>;
    /** Items that were removed from the collection */
    removed?: Set<T>;
}
/**
 * The source of a change to the store.
 * - `'user'` - Changes originating from local user actions
 * - `'remote'` - Changes originating from remote synchronization
 *
 * @public
 */
export type ChangeSource = 'user' | 'remote';
/**
 * Filters for store listeners to control which changes trigger the listener.
 *
 * @example
 * ```ts
 * const filters: StoreListenerFilters = {
 *   source: 'user', // Only listen to user changes
 *   scope: 'document' // Only listen to document-scoped records
 * }
 * ```
 *
 * @public
 */
export interface StoreListenerFilters {
    /** Filter by the source of changes */
    source: ChangeSource | 'all';
    /** Filter by the scope of records */
    scope: RecordScope | 'all';
}
/**
 * An entry containing changes that originated either by user actions or remote changes.
 * History entries are used to track and replay changes to the store.
 *
 * @example
 * ```ts
 * const entry: HistoryEntry<Book> = {
 *   changes: {
 *     added: { 'book:123': bookRecord },
 *     updated: {},
 *     removed: {}
 *   },
 *   source: 'user'
 * }
 * ```
 *
 * @public
 */
export interface HistoryEntry<R extends UnknownRecord = UnknownRecord> {
    /** The changes that occurred in this history entry */
    changes: RecordsDiff<R>;
    /** The source of these changes */
    source: ChangeSource;
}
/**
 * A function that will be called when the history changes.
 *
 * @example
 * ```ts
 * const listener: StoreListener<Book> = (entry) => {
 *   console.log('Changes:', entry.changes)
 *   console.log('Source:', entry.source)
 * }
 *
 * store.listen(listener)
 * ```
 *
 * @param entry - The history entry containing the changes
 *
 * @public
 */
export type StoreListener<R extends UnknownRecord> = (entry: HistoryEntry<R>) => void;
/**
 * A computed cache that stores derived data for records.
 * The cache automatically updates when underlying records change and cleans up when records are deleted.
 *
 * @example
 * ```ts
 * const expensiveCache = store.createComputedCache(
 *   'expensive',
 *   (book: Book) => performExpensiveCalculation(book)
 * )
 *
 * const result = expensiveCache.get(bookId)
 * ```
 *
 * @public
 */
export interface ComputedCache<Data, R extends UnknownRecord> {
    /**
     * Get the cached data for a record by its ID.
     *
     * @param id - The ID of the record
     * @returns The cached data or undefined if the record doesn't exist
     */
    get(id: IdOf<R>): Data | undefined;
}
/**
 * Options for creating a computed cache.
 *
 * @example
 * ```ts
 * const options: CreateComputedCacheOpts<string[], Book> = {
 *   areRecordsEqual: (a, b) => a.title === b.title,
 *   areResultsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b)
 * }
 * ```
 *
 * @public
 */
export interface CreateComputedCacheOpts<Data, R extends UnknownRecord> {
    /** Custom equality function for comparing records */
    areRecordsEqual?(a: R, b: R): boolean;
    /** Custom equality function for comparing results */
    areResultsEqual?(a: Data, b: Data): boolean;
}
/**
 * A serialized snapshot of the record store's values.
 * This is a plain JavaScript object that can be saved to storage or transmitted over the network.
 *
 * @example
 * ```ts
 * const serialized: SerializedStore<Book> = {
 *   'book:123': { id: 'book:123', typeName: 'book', title: 'The Lathe of Heaven' },
 *   'book:456': { id: 'book:456', typeName: 'book', title: 'The Left Hand of Darkness' }
 * }
 * ```
 *
 * @public
 */
export type SerializedStore<R extends UnknownRecord> = Record<IdOf<R>, R>;
/**
 * A snapshot of the store including both data and schema information.
 * This enables proper migration when loading data from different schema versions.
 *
 * @example
 * ```ts
 * const snapshot = store.getStoreSnapshot()
 * // Later...
 * store.loadStoreSnapshot(snapshot)
 * ```
 *
 * @public
 */
export interface StoreSnapshot<R extends UnknownRecord> {
    /** The serialized store data */
    store: SerializedStore<R>;
    /** The serialized schema information */
    schema: SerializedSchema;
}
/**
 * A validator for store records that ensures data integrity.
 * Validators are called when records are created or updated.
 *
 * @example
 * ```ts
 * const bookValidator: StoreValidator<Book> = {
 *   validate(record: unknown): Book {
 *     // Validate and return the record
 *     if (typeof record !== 'object' || !record.title) {
 *       throw new Error('Invalid book')
 *     }
 *     return record as Book
 *   }
 * }
 * ```
 *
 * @public
 */
export interface StoreValidator<R extends UnknownRecord> {
    /**
     * Validate a record.
     *
     * @param record - The record to validate
     * @returns The validated record
     * @throws When validation fails
     */
    validate(record: unknown): R;
    /**
     * Validate a record using a known good version for reference.
     *
     * @param knownGoodVersion - A known valid version of the record
     * @param record - The record to validate
     * @returns The validated record
     */
    validateUsingKnownGoodVersion?(knownGoodVersion: R, record: unknown): R;
}
/**
 * A map of validators for each record type in the store.
 *
 * @example
 * ```ts
 * const validators: StoreValidators<Book | Author> = {
 *   book: bookValidator,
 *   author: authorValidator
 * }
 * ```
 *
 * @public
 */
export type StoreValidators<R extends UnknownRecord> = {
    [K in R['typeName']]: StoreValidator<Extract<R, {
        typeName: K;
    }>>;
};
/**
 * Information about an error that occurred in the store.
 *
 * @example
 * ```ts
 * const error: StoreError = {
 *   error: new Error('Validation failed'),
 *   phase: 'updateRecord',
 *   recordBefore: oldRecord,
 *   recordAfter: newRecord,
 *   isExistingValidationIssue: false
 * }
 * ```
 *
 * @public
 */
export interface StoreError {
    /** The error that occurred */
    error: Error;
    /** The phase during which the error occurred */
    phase: 'initialize' | 'createRecord' | 'updateRecord' | 'tests';
    /** The record state before the operation (if applicable) */
    recordBefore?: unknown;
    /** The record state after the operation */
    recordAfter: unknown;
    /** Whether this is an existing validation issue */
    isExistingValidationIssue: boolean;
}
/**
 * Extract the record type from a Store type.
 * Used internally for type inference.
 *
 * @internal
 */
export type StoreRecord<S extends Store<any>> = S extends Store<infer R> ? R : never;
/**
 * A reactive store that manages collections of typed records.
 *
 * The Store is the central container for your application's data, providing:
 * - Reactive state management with automatic updates
 * - Type-safe record operations
 * - History tracking and change notifications
 * - Schema validation and migrations
 * - Side effects and business logic hooks
 * - Efficient querying and indexing
 *
 * @example
 * ```ts
 * // Create a store with schema
 * const schema = StoreSchema.create({
 *   book: Book,
 *   author: Author
 * })
 *
 * const store = new Store({
 *   schema,
 *   props: {}
 * })
 *
 * // Add records
 * const book = Book.create({ title: 'The Lathe of Heaven', author: 'Le Guin' })
 * store.put([book])
 *
 * // Listen to changes
 * store.listen((entry) => {
 *   console.log('Changes:', entry.changes)
 * })
 * ```
 *
 * @public
 */
export declare class Store<R extends UnknownRecord = UnknownRecord, Props = unknown> {
    /**
     * The unique identifier of the store instance.
     *
     * @public
     */
    readonly id: string;
    /**
     * An AtomMap containing the stores records.
     *
     * @internal
     * @readonly
     */
    private readonly records;
    /**
     * An atom containing the store's history.
     *
     * @public
     * @readonly
     */
    readonly history: Atom<number, RecordsDiff<R>>;
    /**
     * Reactive queries and indexes for efficiently accessing store data.
     * Provides methods for filtering, indexing, and subscribing to subsets of records.
     *
     * @example
     * ```ts
     * // Create an index by a property
     * const booksByAuthor = store.query.index('book', 'author')
     *
     * // Get records matching criteria
     * const inStockBooks = store.query.records('book', () => ({
     *   inStock: { eq: true }
     * }))
     * ```
     *
     * @public
     * @readonly
     */
    readonly query: StoreQueries<R>;
    /**
     * A set containing listeners that have been added to this store.
     *
     * @internal
     */
    private listeners;
    /**
     * An array of history entries that have not yet been flushed.
     *
     * @internal
     */
    private historyAccumulator;
    /**
     * A reactor that responds to changes to the history by squashing the accumulated history and
     * notifying listeners of the changes.
     *
     * @internal
     */
    private historyReactor;
    /**
     * Function to dispose of any in-flight timeouts.
     *
     * @internal
     */
    private cancelHistoryReactor;
    /**
     * The schema that defines the structure and validation rules for records in this store.
     *
     * @public
     */
    readonly schema: StoreSchema<R, Props>;
    /**
     * Custom properties associated with this store instance.
     *
     * @public
     */
    readonly props: Props;
    /**
     * A mapping of record scopes to the set of record type names that belong to each scope.
     * Used to filter records by their persistence and synchronization behavior.
     *
     * @public
     */
    readonly scopedTypes: {
        readonly [K in RecordScope]: ReadonlySet<R['typeName']>;
    };
    /**
     * Side effects manager that handles lifecycle events for record operations.
     * Allows registration of callbacks for create, update, delete, and validation events.
     *
     * @example
     * ```ts
     * store.sideEffects.registerAfterCreateHandler('book', (book) => {
     *   console.log('Book created:', book.title)
     * })
     * ```
     *
     * @public
     */
    readonly sideEffects: StoreSideEffects<R>;
    /**
     * Creates a new Store instance.
     *
     * @example
     * ```ts
     * const store = new Store({
     *   schema: StoreSchema.create({ book: Book }),
     *   props: { appName: 'MyLibrary' },
     *   initialData: savedData
     * })
     * ```
     *
     * @param config - Configuration object for the store
     */
    constructor(config: {
        /** Optional unique identifier for the store */
        id?: string;
        /** The store's initial data to populate on creation */
        initialData?: SerializedStore<R>;
        /** The schema defining record types, validation, and migrations */
        schema: StoreSchema<R, Props>;
        /** Custom properties for the store instance */
        props: Props;
    });
    _flushHistory(): void;
    dispose(): void;
    /**
     * Filters out non-document changes from a diff. Returns null if there are no changes left.
     * @param change - the records diff
     * @param scope - the records scope
     * @returns
     */
    filterChangesByScope(change: RecordsDiff<R>, scope: RecordScope): {
        added: { [K in IdOf<R>]: R; };
        updated: { [K in IdOf<R>]: [from: R, to: R]; };
        removed: { [K in IdOf<R>]: R; };
    } | null;
    /**
     * Update the history with a diff of changes.
     *
     * @param changes - The changes to add to the history.
     */
    private updateHistory;
    validate(phase: 'initialize' | 'createRecord' | 'updateRecord' | 'tests'): void;
    /**
     * Add or update records in the store. If a record with the same ID already exists, it will be updated.
     * Otherwise, a new record will be created.
     *
     * @example
     * ```ts
     * // Add new records
     * const book = Book.create({ title: 'Lathe Of Heaven', author: 'Le Guin' })
     * store.put([book])
     *
     * // Update existing record
     * store.put([{ ...book, title: 'The Lathe of Heaven' }])
     * ```
     *
     * @param records - The records to add or update
     * @param phaseOverride - Override the validation phase (used internally)
     * @public
     */
    put(records: R[], phaseOverride?: 'initialize'): void;
    /**
     * Remove records from the store by their IDs.
     *
     * @example
     * ```ts
     * // Remove a single record
     * store.remove([book.id])
     *
     * // Remove multiple records
     * store.remove([book1.id, book2.id, book3.id])
     * ```
     *
     * @param ids - The IDs of the records to remove
     * @public
     */
    remove(ids: IdOf<R>[]): void;
    /**
     * Get a record by its ID. This creates a reactive subscription to the record.
     *
     * @example
     * ```ts
     * const book = store.get(bookId)
     * if (book) {
     *   console.log(book.title)
     * }
     * ```
     *
     * @param id - The ID of the record to get
     * @returns The record if it exists, undefined otherwise
     * @public
     */
    get<K extends IdOf<R>>(id: K): RecordFromId<K> | undefined;
    /**
     * Get a record by its ID without creating a reactive subscription.
     * Use this when you need to access a record but don't want reactive updates.
     *
     * @example
     * ```ts
     * // Won't trigger reactive updates when this record changes
     * const book = store.unsafeGetWithoutCapture(bookId)
     * ```
     *
     * @param id - The ID of the record to get
     * @returns The record if it exists, undefined otherwise
     * @public
     */
    unsafeGetWithoutCapture<K extends IdOf<R>>(id: K): RecordFromId<K> | undefined;
    /**
     * Serialize the store's records to a plain JavaScript object.
     * Only includes records matching the specified scope.
     *
     * @example
     * ```ts
     * // Serialize only document records (default)
     * const documentData = store.serialize('document')
     *
     * // Serialize all records
     * const allData = store.serialize('all')
     * ```
     *
     * @param scope - The scope of records to serialize. Defaults to 'document'
     * @returns The serialized store data
     * @public
     */
    serialize(scope?: RecordScope | 'all'): SerializedStore<R>;
    /**
     * Get a serialized snapshot of the store and its schema.
     * This includes both the data and schema information needed for proper migration.
     *
     * @example
     * ```ts
     * const snapshot = store.getStoreSnapshot()
     * localStorage.setItem('myApp', JSON.stringify(snapshot))
     *
     * // Later...
     * const saved = JSON.parse(localStorage.getItem('myApp'))
     * store.loadStoreSnapshot(saved)
     * ```
     *
     * @param scope - The scope of records to serialize. Defaults to 'document'
     * @returns A snapshot containing both store data and schema information
     * @public
     */
    getStoreSnapshot(scope?: RecordScope | 'all'): StoreSnapshot<R>;
    /**
     * Migrate a serialized snapshot to the current schema version.
     * This applies any necessary migrations to bring old data up to date.
     *
     * @example
     * ```ts
     * const oldSnapshot = JSON.parse(localStorage.getItem('myApp'))
     * const migratedSnapshot = store.migrateSnapshot(oldSnapshot)
     * ```
     *
     * @param snapshot - The snapshot to migrate
     * @returns The migrated snapshot with current schema version
     * @throws Error if migration fails
     * @public
     */
    migrateSnapshot(snapshot: StoreSnapshot<R>): StoreSnapshot<R>;
    /**
     * Load a serialized snapshot into the store, replacing all current data.
     * The snapshot will be automatically migrated to the current schema version if needed.
     *
     * @example
     * ```ts
     * const snapshot = JSON.parse(localStorage.getItem('myApp'))
     * store.loadStoreSnapshot(snapshot)
     * ```
     *
     * @param snapshot - The snapshot to load
     * @throws Error if migration fails or snapshot is invalid
     * @public
     */
    loadStoreSnapshot(snapshot: StoreSnapshot<R>): void;
    /**
     * Get an array of all records in the store.
     *
     * @example
     * ```ts
     * const allRecords = store.allRecords()
     * const books = allRecords.filter(r => r.typeName === 'book')
     * ```
     *
     * @returns An array containing all records in the store
     * @public
     */
    allRecords(): R[];
    /**
     * Remove all records from the store.
     *
     * @example
     * ```ts
     * store.clear()
     * console.log(store.allRecords().length) // 0
     * ```
     *
     * @public
     */
    clear(): void;
    /**
     * Update a single record using an updater function. To update multiple records at once,
     * use the `update` method of the `TypedStore` class.
     *
     * @example
     * ```ts
     * store.update(book.id, (book) => ({
     *   ...book,
     *   title: 'Updated Title'
     * }))
     * ```
     *
     * @param id - The ID of the record to update
     * @param updater - A function that receives the current record and returns the updated record
     * @public
     */
    update<K extends IdOf<R>>(id: K, updater: (record: RecordFromId<K>) => RecordFromId<K>): void;
    /**
     * Check whether a record with the given ID exists in the store.
     *
     * @example
     * ```ts
     * if (store.has(bookId)) {
     *   console.log('Book exists!')
     * }
     * ```
     *
     * @param id - The ID of the record to check
     * @returns True if the record exists, false otherwise
     * @public
     */
    has<K extends IdOf<R>>(id: K): boolean;
    /**
     * Add a listener that will be called when the store changes.
     * Returns a function to remove the listener.
     *
     * @example
     * ```ts
     * const removeListener = store.listen((entry) => {
     *   console.log('Changes:', entry.changes)
     *   console.log('Source:', entry.source)
     * })
     *
     * // Listen only to user changes to document records
     * const removeDocumentListener = store.listen(
     *   (entry) => console.log('Document changed:', entry),
     *   { source: 'user', scope: 'document' }
     * )
     *
     * // Later, remove the listener
     * removeListener()
     * ```
     *
     * @param onHistory - The listener function to call when changes occur
     * @param filters - Optional filters to control when the listener is called
     * @returns A function that removes the listener when called
     * @public
     */
    listen(onHistory: StoreListener<R>, filters?: Partial<StoreListenerFilters>): () => void;
    private isMergingRemoteChanges;
    /**
     * Merge changes from a remote source. Changes made within the provided function
     * will be marked with source 'remote' instead of 'user'.
     *
     * @example
     * ```ts
     * // Changes from sync/collaboration
     * store.mergeRemoteChanges(() => {
     *   store.put(remoteRecords)
     *   store.remove(deletedIds)
     * })
     * ```
     *
     * @param fn - A function that applies the remote changes
     * @public
     */
    mergeRemoteChanges(fn: () => void): void;
    /**
     * Run `fn` and return a {@link RecordsDiff} of the changes that occurred as a result.
     */
    extractingChanges(fn: () => void): RecordsDiff<R>;
    applyDiff(diff: RecordsDiff<R>, { runCallbacks, ignoreEphemeralKeys }?: {
        runCallbacks?: boolean;
        ignoreEphemeralKeys?: boolean;
    }): void;
    /**
     * Create a cache based on values in the store. Pass in a function that takes and ID and a
     * signal for the underlying record. Return a signal (usually a computed) for the cached value.
     * For simple derivations, use {@link Store.createComputedCache}. This function is useful if you
     * need more precise control over intermediate values.
     */
    createCache<Result, Record extends R = R>(create: (id: IdOf<Record>, recordSignal: Signal<R>) => Signal<Result>): {
        get: (id: IdOf<Record>) => Result | undefined;
    };
    /**
     * Create a computed cache.
     *
     * @param name - The name of the derivation cache.
     * @param derive - A function used to derive the value of the cache.
     * @param opts - Options for the computed cache.
     * @public
     */
    createComputedCache<Result, Record extends R = R>(name: string, derive: (record: Record) => Result | undefined, opts?: CreateComputedCacheOpts<Result, Record>): ComputedCache<Result, Record>;
    private _integrityChecker?;
    /** @internal */
    ensureStoreIsUsable(): void;
    private _isPossiblyCorrupted;
    /** @internal */
    markAsPossiblyCorrupted(): void;
    /** @internal */
    isPossiblyCorrupted(): boolean;
    private pendingAfterEvents;
    private addDiffForAfterEvent;
    private flushAtomicCallbacks;
    private _isInAtomicOp;
    /** @internal */
    atomic<T>(fn: () => T, runCallbacks?: boolean, isMergingRemoteChanges?: boolean): T;
    /** @internal */
    addHistoryInterceptor(fn: (entry: HistoryEntry<R>, source: ChangeSource) => void): () => void;
}
/**
 * A store or an object containing a store.
 * This type is used for APIs that can accept either a store directly or an object with a store property.
 *
 * @example
 * ```ts
 * function useStore(storeOrObject: StoreObject<MyRecord>) {
 *   const store = storeOrObject instanceof Store ? storeOrObject : storeOrObject.store
 *   return store
 * }
 * ```
 *
 * @public
 */
export type StoreObject<R extends UnknownRecord> = Store<R> | {
    store: Store<R>;
};
/**
 * Extract the record type from a StoreObject.
 *
 * @example
 * ```ts
 * type MyStoreObject = { store: Store<Book | Author> }
 * type Records = StoreObjectRecordType<MyStoreObject> // Book | Author
 * ```
 *
 * @public
 */
export type StoreObjectRecordType<Context extends StoreObject<any>> = Context extends Store<infer R> ? R : Context extends {
    store: Store<infer R>;
} ? R : never;
/**
 * Create a computed cache that works with any StoreObject (store or object containing a store).
 * This is a standalone version of Store.createComputedCache that can work with multiple store instances.
 *
 * @example
 * ```ts
 * const expensiveCache = createComputedCache(
 *   'expensiveData',
 *   (context: { store: Store<Book> }, book: Book) => {
 *     return performExpensiveCalculation(book)
 *   }
 * )
 *
 * // Use with different store instances
 * const result1 = expensiveCache.get(storeObject1, bookId)
 * const result2 = expensiveCache.get(storeObject2, bookId)
 * ```
 *
 * @param name - A unique name for the cache (used for debugging)
 * @param derive - Function that derives a value from the context and record
 * @param opts - Optional configuration for equality checks
 * @returns A cache that can be used with multiple store instances
 * @public
 */
export declare function createComputedCache<Context extends StoreObject<any>, Result, Record extends StoreObjectRecordType<Context> = StoreObjectRecordType<Context>>(name: string, derive: (context: Context, record: Record) => Result | undefined, opts?: CreateComputedCacheOpts<Result, Record>): {
    get(context: Context, id: IdOf<Record>): Result | undefined;
};
//# sourceMappingURL=Store.d.ts.map