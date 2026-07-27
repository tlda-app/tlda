import { Signal } from '@tldraw/state';
import { UnknownRecord } from '@tldraw/store';
import { TLPageId, TLShapeId, TLStore } from '@tldraw/tlschema';
/**
 * A string that is unique per browser tab
 * @public
 */
export declare const TAB_ID: string;
/**
 * The state of the editor instance, not including any document state.
 *
 * @public
 */
export interface TLSessionStateSnapshot {
    version: number;
    currentPageId?: TLPageId;
    isFocusMode?: boolean;
    exportBackground?: boolean;
    isDebugMode?: boolean;
    isToolLocked?: boolean;
    isGridMode?: boolean;
    pageStates?: Array<{
        pageId: TLPageId;
        camera?: {
            x: number;
            y: number;
            z: number;
        };
        selectedShapeIds?: TLShapeId[];
        focusedGroupId?: TLShapeId | null;
    }>;
}
/**
 * Creates a signal of the instance state for a given store.
 * @public
 * @param store - The store to create the instance state snapshot signal for
 * @returns
 */
export declare function createSessionStateSnapshotSignal(store: TLStore): Signal<TLSessionStateSnapshot | null>;
/**
 * Options for {@link loadSessionStateSnapshotIntoStore}
 * @public
 */
export interface TLLoadSessionStateSnapshotOptions {
    /**
     * By default, some session state flags like `isDebugMode` are not overwritten when loading a snapshot.
     * These are usually considered "sticky" by users while the document data is not.
     * If you want to overwrite these flags, set this to `true`.
     */
    forceOverwrite?: boolean;
}
/**
 * Loads a snapshot of the editor's instance state into the store of a new editor instance.
 *
 * @public
 * @param store - The store to load the instance state into
 * @param snapshot - The instance state snapshot to load
 * @returns
 */
export declare function loadSessionStateSnapshotIntoStore(store: TLStore, snapshot: TLSessionStateSnapshot, opts?: TLLoadSessionStateSnapshotOptions): void;
/**
 * @internal
 */
export declare function extractSessionStateFromLegacySnapshot(store: Record<string, UnknownRecord>): TLSessionStateSnapshot | null;
//# sourceMappingURL=TLSessionStateSnapshot.d.ts.map