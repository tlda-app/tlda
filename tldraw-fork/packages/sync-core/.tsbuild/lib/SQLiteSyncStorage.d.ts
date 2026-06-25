import { SerializedSchema, StoreSnapshot, UnknownRecord } from '@tldraw/store';
import { RoomSnapshot } from './TLSyncRoom';
import { TLSyncStorage, TLSyncStorageOnChangeCallbackProps, TLSyncStorageTransactionCallback, TLSyncStorageTransactionOptions, TLSyncStorageTransactionResult } from './TLSyncStorage';
/**
 * Valid input value types for SQLite query parameters.
 * These are the types that can be passed as bindings to prepared statements.
 * @public
 */
export type TLSqliteInputValue = null | number | bigint | string | Uint8Array;
/**
 * Possible output value types returned from SQLite queries.
 * Includes all input types plus Uint8Array for BLOB columns.
 * @public
 */
export type TLSqliteOutputValue = null | number | bigint | string | Uint8Array;
/**
 * A row returned from a SQLite query, mapping column names to their values.
 * @public
 */
export type TLSqliteRow = Record<string, TLSqliteOutputValue>;
/**
 * A prepared statement that can be executed multiple times with different bindings.
 * @public
 */
export interface TLSyncSqliteStatement<TResult extends TLSqliteRow | void, TParams extends TLSqliteInputValue[] = []> {
    /** Execute the statement and iterate over results one at a time */
    iterate(...bindings: TParams): IterableIterator<TResult>;
    /** Execute the statement and return all results as an array */
    all(...bindings: TParams): TResult[];
    /** Execute the statement without returning results (for DML) */
    run(...bindings: TParams): void;
}
/**
 * Configuration for SQLiteSyncStorage.
 * @public
 */
export interface TLSyncSqliteWrapperConfig {
    /** Prefix for all table names (default: ''). E.g. 'sync_' creates tables 'sync_documents', 'sync_tombstones', 'sync_metadata' */
    tablePrefix?: string;
}
/**
 * Interface for SQLite storage with prepare, exec and transaction capabilities.
 * @public
 */
export interface TLSyncSqliteWrapper {
    /** Optional configuration for table names. If not provided, defaults are used. */
    readonly config?: TLSyncSqliteWrapperConfig;
    /** Prepare a SQL statement for execution */
    prepare<TResult extends TLSqliteRow | void, TParams extends TLSqliteInputValue[] = []>(sql: string): TLSyncSqliteStatement<TResult, TParams>;
    /** Execute raw SQL (for DDL, multi-statement scripts) */
    exec(sql: string): void;
    /** Execute a callback within a transaction */
    transaction<T>(callback: () => T): T;
}
export declare function migrateSqliteSyncStorage(storage: TLSyncSqliteWrapper, { documentsTable, tombstonesTable, metadataTable }?: {
    documentsTable?: string;
    tombstonesTable?: string;
    metadataTable?: string;
}): void;
/**
 * SQLite-based implementation of TLSyncStorage.
 * Stores documents, tombstones, metadata, and clock values in SQLite tables.
 *
 * This storage backend provides persistent synchronization state that survives
 * process restarts, unlike InMemorySyncStorage which loses data when the process ends.
 *
 * @example
 * ```ts
 * // With Cloudflare Durable Objects
 * import { SQLiteSyncStorage, DurableObjectSqliteSyncWrapper } from '@tldraw/sync-core'
 *
 * const sql = new DurableObjectSqliteSyncWrapper(this.ctx.storage)
 * const storage = new SQLiteSyncStorage({ sql })
 * ```
 *
 * @example
 * ```ts
 * // With Node.js sqlite (Node 22.5+)
 * import { DatabaseSync } from 'node:sqlite'
 * import { SQLiteSyncStorage, NodeSqliteWrapper } from '@tldraw/sync-core'
 *
 * const db = new DatabaseSync('sync-state.db')
 * const sql = new NodeSqliteWrapper(db)
 * const storage = new SQLiteSyncStorage({ sql })
 * ```
 *
 * @example
 * ```ts
 * // Initialize with an existing snapshot
 * const storage = new SQLiteSyncStorage({ sql, snapshot: existingSnapshot })
 * ```
 *
 * @public
 */
export declare class SQLiteSyncStorage<R extends UnknownRecord> implements TLSyncStorage<R> {
    /**
     * Check if the storage has been initialized (has data in the clock table).
     * Useful for determining whether to load from an external source on first access.
     */
    static hasBeenInitialized(storage: TLSyncSqliteWrapper): boolean;
    /**
     * Get the current document clock value from storage without fully initializing.
     * Returns null if storage has not been initialized.
     * Useful for comparing storage freshness against external sources.
     */
    static getDocumentClock(storage: TLSyncSqliteWrapper): number | null;
    private readonly stmts;
    private readonly sql;
    constructor({ sql, snapshot, onChange }: {
        sql: TLSyncSqliteWrapper;
        snapshot?: RoomSnapshot | StoreSnapshot<R>;
        onChange?(arg: TLSyncStorageOnChangeCallbackProps): unknown;
    });
    private notifier;
    onChange(callback: (arg: TLSyncStorageOnChangeCallbackProps) => void): () => void;
    transaction<T>(callback: TLSyncStorageTransactionCallback<R, T>, opts?: TLSyncStorageTransactionOptions): TLSyncStorageTransactionResult<T, R>;
    getClock(): number;
    /** @internal */
    _getTombstoneHistoryStartsAtClock(): number;
    /** @internal */
    _getSchema(): SerializedSchema;
    /** @internal */
    _setSchema(schema: SerializedSchema): void;
    /** @internal */
    pruneTombstones: import("lodash").DebouncedFunc<() => void>;
    getSnapshot(): RoomSnapshot;
    private _iterateDocuments;
    private _iterateTombstones;
}
//# sourceMappingURL=SQLiteSyncStorage.d.ts.map