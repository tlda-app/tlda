import { TLStore, TLStoreSnapshot } from '@tldraw/tlschema';
import { TLSessionStateSnapshot } from './TLSessionStateSnapshot';
/** @public */
export interface TLEditorSnapshot {
    document: TLStoreSnapshot;
    session: TLSessionStateSnapshot;
}
/**
 * Options for {@link loadSnapshot}
 * @public
 */
export interface TLLoadSnapshotOptions {
    /**
     * By default, some session state flags like `isDebugMode` are not overwritten when loading a snapshot.
     * These are usually considered "sticky" by users while the document data is not.
     * If you want to overwrite these flags, set this to `true`.
     */
    forceOverwriteSessionState?: boolean;
}
/**
 * Loads a snapshot into a store.
 * @public
 */
export declare function loadSnapshot(store: TLStore, _snapshot: Partial<TLEditorSnapshot> | TLStoreSnapshot, opts?: TLLoadSnapshotOptions): void;
/** @public */
export declare function getSnapshot(store: TLStore): TLEditorSnapshot;
//# sourceMappingURL=TLEditorSnapshot.d.ts.map