import { TLShape, TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../editor/Editor';
import { Vec, VecLike } from '../primitives/Vec';
/** @internal */
export declare function getRotationSnapshot({ editor, ids }: {
    editor: Editor;
    ids: TLShapeId[];
}): null | TLRotationSnapshot;
/**
 * @internal
 **/
export interface TLRotationSnapshot {
    initialPageCenter: Vec;
    initialCursorAngle: number;
    initialShapesRotation: number;
    shapeSnapshots: {
        initialPagePoint: Vec;
        shape: TLShape;
    }[];
}
/** @internal */
export declare function applyRotationToSnapshotShapes({ delta, editor, snapshot, stage, centerOverride }: {
    centerOverride?: VecLike;
    delta: number;
    editor: Editor;
    snapshot: TLRotationSnapshot;
    stage: 'end' | 'one-off' | 'start' | 'update';
}): void;
//# sourceMappingURL=rotation.d.ts.map