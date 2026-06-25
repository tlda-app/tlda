import { TLRecord } from '@tldraw/tlschema';
import { RoomSnapshot } from '../lib/TLSyncRoom';
import { TLSyncStorage, TLSyncStorageOnChangeCallbackProps } from '../lib/TLSyncStorage';
export declare const contractSchema: import("tldraw").TLSchema;
export declare function makeContractSnapshot(records: TLRecord[], others?: Partial<RoomSnapshot>): RoomSnapshot;
export declare const contractRecords: (import("tldraw").TLDocument | import("tldraw").TLPage)[];
export declare function makePage(id: string, name?: string, index?: string): import("tldraw").TLPage;
export interface StorageContractFactory {
    create(opts?: {
        snapshot?: RoomSnapshot;
        onChange?(arg: TLSyncStorageOnChangeCallbackProps): void;
    }): TLSyncStorage<TLRecord>;
}
/**
 * The shared behavior suite for the storage contract (SPEC.md section 10, SS rules).
 * Runs against both InMemorySyncStorage and SQLiteSyncStorage.
 */
export declare function registerStorageContractTests(factory: StorageContractFactory): void;
//# sourceMappingURL=storageContractSuite.d.ts.map