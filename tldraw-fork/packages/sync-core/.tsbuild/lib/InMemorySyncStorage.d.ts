import { Atom } from '@tldraw/state';
import { AtomMap, SerializedSchema, UnknownRecord } from '@tldraw/store';
import { RoomSnapshot } from './TLSyncRoom';
import { TLSyncStorage, TLSyncStorageOnChangeCallbackProps, TLSyncStorageTransactionCallback, TLSyncStorageTransactionOptions, TLSyncStorageTransactionResult } from './TLSyncStorage';
/** @internal */
export declare const TOMBSTONE_PRUNE_BUFFER_SIZE = 1000;
/** @internal */
export declare const MAX_TOMBSTONES = 5000;
/**
 * Result of computing which tombstones to prune.
 * @internal
 */
export interface TombstonePruneResult {
    /** The new value for tombstoneHistoryStartsAtClock */
    newTombstoneHistoryStartsAtClock: number;
    /** IDs of tombstones to delete */
    idsToDelete: string[];
}
/**
 * Computes which tombstones should be pruned, avoiding partial history for any clock value.
 * Returns null if no pruning is needed (tombstone count <= maxTombstones).
 *
 * @param tombstones - Array of tombstones sorted by clock ascending (oldest first)
 * @param documentClock - Current document clock (used as fallback if all tombstones are deleted)
 * @param maxTombstones - Maximum number of tombstones to keep (default: MAX_TOMBSTONES)
 * @param pruneBufferSize - Extra tombstones to prune beyond the threshold (default: TOMBSTONE_PRUNE_BUFFER_SIZE)
 * @returns Pruning result or null if no pruning needed
 *
 * @internal
 */
export declare function computeTombstonePruning({ tombstones, documentClock, maxTombstones, pruneBufferSize }: {
    tombstones: Array<{
        id: string;
        clock: number;
    }>;
    documentClock: number;
    maxTombstones?: number;
    pruneBufferSize?: number;
}): TombstonePruneResult | null;
/**
 * Default initial snapshot for a new room.
 * @public
 */
export declare const DEFAULT_INITIAL_SNAPSHOT: {
    documentClock: number;
    tombstoneHistoryStartsAtClock: number;
    schema: import("tldraw").SerializedSchemaV2;
    documents: ({
        state: import("tldraw").TLDocument;
        lastChangedClock: number;
    } | {
        state: import("tldraw").TLPage;
        lastChangedClock: number;
    })[];
};
/**
 * In-memory implementation of TLSyncStorage using AtomMap for documents and tombstones,
 * and atoms for clock values. This is the default storage implementation used by TLSyncRoom.
 *
 * @public
 */
export declare class InMemorySyncStorage<R extends UnknownRecord> implements TLSyncStorage<R> {
    /** @internal */
    documents: AtomMap<string, {
        state: R;
        lastChangedClock: number;
    }>;
    /** @internal */
    tombstones: AtomMap<string, number>;
    /** @internal */
    schema: Atom<SerializedSchema>;
    /** @internal */
    documentClock: Atom<number>;
    /** @internal */
    tombstoneHistoryStartsAtClock: Atom<number>;
    private notifier;
    onChange(callback: (arg: TLSyncStorageOnChangeCallbackProps) => unknown): () => void;
    constructor({ snapshot, onChange }?: {
        snapshot?: RoomSnapshot;
        onChange?(arg: TLSyncStorageOnChangeCallbackProps): unknown;
    });
    transaction<T>(callback: TLSyncStorageTransactionCallback<R, T>, opts?: TLSyncStorageTransactionOptions): TLSyncStorageTransactionResult<T, R>;
    getClock(): number;
    /** @internal */
    pruneTombstones: import("lodash").DebouncedFunc<() => void>;
    getSnapshot(): RoomSnapshot;
}
//# sourceMappingURL=InMemorySyncStorage.d.ts.map