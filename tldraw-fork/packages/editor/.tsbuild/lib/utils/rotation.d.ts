import { TLShape, TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../editor/Editor';
import { Vec, VecLike } from '../primitives/Vec';
/** @internal */
export declare function getRotationSnapshot({ editor, ids }: {
    editor: Editor;
    ids: TLShapeId[];
}): TLRotationSnapshot | null;
/**
 * @internal
 **/
export interface TLRotationSnapshot {
    initialPageCenter: Vec;
    initialCursorAngle: number;
    initialShapesRotation: number;
    shapeSnapshots: {
        shape: TLShape;
        initialPagePoint: Vec;
    }[];
}
/** @internal */
export declare function applyRotationToSnapshotShapes({ delta, editor, snapshot, stage, centerOverride }: {
    delta: number;
    snapshot: TLRotationSnapshot;
    editor: Editor;
    stage: 'start' | 'update' | 'end' | 'one-off';
    centerOverride?: VecLike;
}): void;
//# sourceMappingURL=rotation.d.ts.map