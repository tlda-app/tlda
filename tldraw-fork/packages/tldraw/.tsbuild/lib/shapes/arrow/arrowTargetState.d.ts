import { Editor, ElbowArrowSnap, TLArrowBinding, TLArrowShape, TLArrowShapeKind, TLShape, VecLike } from '@tldraw/editor';
/**
 * Options passed to {@link updateArrowTargetState}.
 *
 * @public
 */
export interface UpdateArrowTargetStateOpts {
    editor: Editor;
    pointInPageSpace: VecLike;
    arrow: TLArrowShape | undefined;
    isPrecise: boolean;
    currentBinding: TLArrowBinding | undefined;
    /** The binding from the opposite end of the arrow, if one exists. */
    oppositeBinding: TLArrowBinding | undefined;
}
/**
 * State representing what we're pointing to when drawing or updating an arrow. You can get this
 * state using {@link getArrowTargetState}, and update it as part of an arrow interaction with
 * {@link updateArrowTargetState} or {@link clearArrowTargetState}.
 *
 * @public
 */
export interface ArrowTargetState {
    target: TLShape;
    arrowKind: TLArrowShapeKind;
    handlesInPageSpace: {
        top: {
            point: VecLike;
            isEnabled: boolean;
        };
        bottom: {
            point: VecLike;
            isEnabled: boolean;
        };
        left: {
            point: VecLike;
            isEnabled: boolean;
        };
        right: {
            point: VecLike;
            isEnabled: boolean;
        };
    };
    isExact: boolean;
    isPrecise: boolean;
    centerInPageSpace: VecLike;
    anchorInPageSpace: VecLike;
    snap: ElbowArrowSnap;
    normalizedAnchor: VecLike;
}
/**
 * Get the current arrow target state for an editor. See {@link ArrowTargetState} for more
 * information.
 *
 * @public
 */
export declare function getArrowTargetState(editor: Editor): ArrowTargetState | null;
/**
 * Clear the current arrow target state for an editor. See {@link ArrowTargetState} for more
 * information.
 *
 * @public
 */
export declare function clearArrowTargetState(editor: Editor): void;
/**
 * Update the current arrow target state for an editor. See {@link ArrowTargetState} for more
 * information.
 *
 * @public
 */
export declare function updateArrowTargetState({ editor, pointInPageSpace, arrow, isPrecise, currentBinding, oppositeBinding }: UpdateArrowTargetStateOpts): ArrowTargetState | null;
//# sourceMappingURL=arrowTargetState.d.ts.map