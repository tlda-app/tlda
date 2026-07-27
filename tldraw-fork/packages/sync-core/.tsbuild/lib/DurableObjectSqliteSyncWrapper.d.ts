import { type TLSqliteInputValue, type TLSqliteRow, type TLSyncSqliteStatement, type TLSyncSqliteWrapper, type TLSyncSqliteWrapperConfig } from './SQLiteSyncStorage';
/**
 * A wrapper around Cloudflare Durable Object's SqlStorage that implements TLSyncSqliteWrapper.
 *
 * Use this wrapper with SQLiteSyncStorage to persist tldraw sync state using
 * Cloudflare Durable Object's built-in SQLite storage. This provides automatic
 * persistence that survives Durable Object hibernation and restarts.
 *
 * @example
 * ```ts
 * import { SQLiteSyncStorage, DurableObjectSqliteSyncWrapper } from '@tldraw/sync-core'
 *
 * // In your Durable Object class:
 * class MyDurableObject extends DurableObject {
 *   private storage: SQLiteSyncStorage
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env)
 *     const sql = new DurableObjectSqliteSyncWrapper(ctx.storage)
 *     this.storage = new SQLiteSyncStorage({ sql })
 *   }
 * }
 * ```
 *
 * @example
 * ```ts
 * // With table prefix to avoid conflicts with other tables
 * const sql = new DurableObjectSqliteSyncWrapper(this.ctx.storage, { tablePrefix: 'tldraw_' })
 * // Creates tables: tldraw_documents, tldraw_tombstones, tldraw_metadata
 * ```
 *
 * @public
 */
export declare class DurableObjectSqliteSyncWrapper implements TLSyncSqliteWrapper {
    private storage;
    config?: TLSyncSqliteWrapperConfig | undefined;
    constructor(storage: {
        sql: {
            exec(sql: string, ...bindings: unknown[]): Iterable<any> & {
                toArray(): any[];
            };
        };
        transactionSync(callback: () => any): any;
    }, config?: TLSyncSqliteWrapperConfig | undefined);
    exec(sql: string): void;
    prepare<TResult extends TLSqliteRow | void = void, TParams extends TLSqliteInputValue[] = []>(sql: string): TLSyncSqliteStatement<TResult, TParams>;
    transaction<T>(callback: () => T): T;
}
//# sourceMappingURL=DurableObjectSqliteSyncWrapper.d.ts.map