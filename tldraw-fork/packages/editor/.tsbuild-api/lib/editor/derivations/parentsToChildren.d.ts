import { Computed } from '@tldraw/state';
import { TLParentId, TLShapeId, TLStore } from '@tldraw/tlschema';
type ParentShapeIdsToChildShapeIds = Record<TLParentId, TLShapeId[]>;
export declare function parentsToChildren(store: TLStore): Computed<ParentShapeIdsToChildShapeIds, unknown>;
export {};
//# sourceMappingURL=parentsToChildren.d.ts.map