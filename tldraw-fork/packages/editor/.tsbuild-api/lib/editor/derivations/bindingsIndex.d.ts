import { Computed } from '@tldraw/state';
import { TLBinding, TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../Editor';
type TLBindingsIndex = Map<TLShapeId, TLBinding[]>;
export declare function bindingsIndex(editor: Editor): Computed<TLBindingsIndex>;
export {};
//# sourceMappingURL=bindingsIndex.d.ts.map