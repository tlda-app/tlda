import { TLStoreSnapshot } from '@tldraw/tlschema';
import { TLStoreOptions } from '../config/createTLStore';
import { TLEditorSnapshot } from '../config/TLEditorSnapshot';
import { TLStoreWithStatus } from '../utils/sync/StoreWithStatus';
/** @internal */
export declare function useLocalStore(options: {
    persistenceKey?: string;
    sessionId?: string;
    snapshot?: TLEditorSnapshot | TLStoreSnapshot;
} & TLStoreOptions): TLStoreWithStatus;
//# sourceMappingURL=useLocalStore.d.ts.map