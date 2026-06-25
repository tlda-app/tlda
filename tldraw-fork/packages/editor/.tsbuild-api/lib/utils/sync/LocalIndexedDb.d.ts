import { RecordsDiff, SerializedStore } from '@tldraw/store';
import { TLStoreSchema } from '@tldraw/tlschema';
import { TLSessionStateSnapshot } from '../../config/TLSessionStateSnapshot';
/** @internal */
export declare const Table: {
    readonly Assets: "assets";
    readonly Records: "records";
    readonly Schema: "schema";
    readonly SessionState: "session_state";
};
/** @internal */
export type StoreName = (typeof Table)[keyof typeof Table];
/** @internal */
export declare class LocalIndexedDb {
    private getDbPromise;
    private isClosed;
    private pendingTransactionSet;
    /** @internal */
    static connectedInstances: Set<LocalIndexedDb>;
    constructor(persistenceKey: string);
    private getDb;
    /**
     * Wait for any pending transactions to be completed. Useful for tests.
     *
     * @internal
     */
    pending(): Promise<void>;
    close(): Promise<void>;
    private tx;
    load({ sessionId }?: {
        sessionId?: string;
    }): Promise<{
        records: any[];
        schema: any;
        sessionStateSnapshot: TLSessionStateSnapshot | undefined;
    }>;
    storeChanges({ schema, changes, sessionId, sessionStateSnapshot }: {
        changes: RecordsDiff<any>;
        schema: TLStoreSchema;
        sessionId?: null | string;
        sessionStateSnapshot?: null | TLSessionStateSnapshot;
    }): Promise<void>;
    storeSnapshot({ schema, snapshot, sessionId, sessionStateSnapshot }: {
        schema: TLStoreSchema;
        sessionId?: null | string;
        sessionStateSnapshot?: null | TLSessionStateSnapshot;
        snapshot: SerializedStore<any>;
    }): Promise<void>;
    pruneSessions(): Promise<void>;
    getAsset(assetId: string): Promise<File | undefined>;
    storeAsset(assetId: string, blob: File): Promise<void>;
    removeAssets(assetId: string[]): Promise<void>;
}
/** @internal */
export declare function getAllIndexDbNames(): string[];
//# sourceMappingURL=LocalIndexedDb.d.ts.map