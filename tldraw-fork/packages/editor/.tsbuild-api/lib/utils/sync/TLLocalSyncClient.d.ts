import { RecordsDiff, SerializedSchema, UnknownRecord } from '@tldraw/store';
import { TLStore } from '@tldraw/tlschema';
import { LocalIndexedDb } from './LocalIndexedDb';
/**
 * IMPORTANT!!!
 *
 * This is just a quick-n-dirty temporary solution that will be replaced with the remote sync client
 * once it has the db integrated
 */
interface SyncMessage {
    type: 'diff';
    storeId: string;
    changes: RecordsDiff<UnknownRecord>;
    schema: SerializedSchema;
}
interface AnnounceMessage {
    type: 'announce';
    schema: SerializedSchema;
}
type Message = AnnounceMessage | SyncMessage;
/** @internal */
export declare class BroadcastChannelMock {
    onmessage?: (e: MessageEvent) => void;
    constructor(_name: string);
    postMessage(_msg: Message): void;
    close(): void;
}
/** @internal */
export declare class TLLocalSyncClient {
    readonly store: TLStore;
    readonly channel: BroadcastChannel | BroadcastChannelMock;
    private disposables;
    private diffQueue;
    private didDispose;
    private shouldDoFullDBWrite;
    private isReloading;
    readonly persistenceKey: string;
    readonly sessionId: string;
    readonly serializedSchema: SerializedSchema;
    private isDebugging;
    private readonly documentTypes;
    private readonly $sessionStateSnapshot;
    /** @internal */
    readonly db: LocalIndexedDb;
    initTime: number;
    private debug;
    constructor(store: TLStore, { persistenceKey, sessionId, onLoad, onLoadError }: {
        onLoad(self: TLLocalSyncClient): void;
        onLoadError(error: Error): void;
        persistenceKey: string;
        sessionId?: string;
    }, channel?: BroadcastChannel | BroadcastChannelMock);
    private connect;
    close(): void;
    private isPersisting;
    private didLastWriteError;
    private scheduledPersistTimeout;
    /**
     * Schedule a persist. Persists don't happen immediately: they are throttled to avoid writing too
     * often, and will retry if failed.
     *
     * @internal
     */
    private schedulePersist;
    /**
     * Persist to IndexedDB only under certain circumstances:
     *
     * - If we're not already persisting
     * - If we're not reloading the page
     * - And we have something to persist (a full db write scheduled or changes in the diff queue)
     *
     * @internal
     */
    private persistIfNeeded;
    private doPersist;
}
export {};
//# sourceMappingURL=TLLocalSyncClient.d.ts.map