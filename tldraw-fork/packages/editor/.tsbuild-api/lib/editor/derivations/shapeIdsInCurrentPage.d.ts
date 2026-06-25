import { TLPageId, TLShapeId, TLStore } from '@tldraw/tlschema';
/**
 * A derivation that returns a list of shape ids in the current page.
 *
 * @param store - The tldraw store.
 * @param getCurrentPageId - A function that returns the current page id.
 */
export declare function deriveShapeIdsInCurrentPage(store: TLStore, getCurrentPageId: () => TLPageId): import("@tldraw/state").Computed<Set<TLShapeId>, unknown>;
//# sourceMappingURL=shapeIdsInCurrentPage.d.ts.map