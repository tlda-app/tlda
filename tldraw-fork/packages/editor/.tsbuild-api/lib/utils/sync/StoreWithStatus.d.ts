import { TLStore } from '@tldraw/tlschema';
/** @public */
export type TLStoreWithStatus = {
    readonly connectionStatus: 'offline' | 'online';
    readonly error?: undefined;
    readonly status: 'synced-remote';
    readonly store: TLStore;
} | {
    readonly error: Error;
    readonly status: 'error';
    readonly store?: undefined;
} | {
    readonly error?: undefined;
    readonly status: 'loading';
    readonly store?: undefined;
} | {
    readonly error?: undefined;
    readonly status: 'not-synced';
    readonly store: TLStore;
} | {
    readonly error?: undefined;
    readonly status: 'synced-local';
    readonly store: TLStore;
};
//# sourceMappingURL=StoreWithStatus.d.ts.map