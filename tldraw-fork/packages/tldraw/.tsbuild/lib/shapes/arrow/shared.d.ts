import { Editor, Geometry2d, Mat, MatModel, TLArrowBinding, TLArrowBindingProps, TLArrowShape, TLShape, TLShapeId, Vec } from '@tldraw/editor';
export declare function getIsArrowStraight(shape: TLArrowShape): boolean;
export interface BoundShapeInfo<T extends TLShape = TLShape> {
    shape: T;
    didIntersect: boolean;
    isExact: boolean;
    isClosed: boolean;
    transform: Mat;
    geometry: Geometry2d;
}
export declare function getBoundShapeInfoForTerminal(editor: Editor, arrow: TLArrowShape, terminalName: 'start' | 'end'): BoundShapeInfo | undefined;
export declare function getArrowTerminalInArrowSpace(editor: Editor, arrowPageTransform: Mat, binding: TLArrowBinding, forceImprecise: boolean): Vec;
/** @public */
export interface TLArrowBindings {
    start: TLArrowBinding | undefined;
    end: TLArrowBinding | undefined;
}
/** @public */
export declare function getArrowBindings(editor: Editor, shape: TLArrowShape): TLArrowBindings;
/** @public */
export declare function getArrowTerminalsInArrowSpace(editor: Editor, shape: TLArrowShape, bindings: TLArrowBindings): {
    start: Vec;
    end: Vec;
};
/**
 * Create or update the arrow binding for a particular arrow terminal. Will clear up if needed.
 * @internal
 */
export declare function createOrUpdateArrowBinding(editor: Editor, arrow: TLArrowShape | TLShapeId, target: TLShape | TLShapeId, props: TLArrowBindingProps): void;
/**
 * Remove any arrow bindings for a particular terminal.
 * @internal
 */
export declare function removeArrowBinding(editor: Editor, arrow: TLArrowShape, terminal: 'start' | 'end'): void;
/** @internal */
export declare const MIN_ARROW_LENGTH = 10;
/** @internal */
export declare const BOUND_ARROW_OFFSET = 10;
/** @internal */
export declare const WAY_TOO_BIG_ARROW_BEND_FACTOR = 10;
/**
 * Get the relationships for an arrow that has two bound shape terminals.
 * If the arrow has only one bound shape, then it is always "safe" to apply
 * standard offsets and precision behavior. If the shape is bound to the same
 * shape on both ends, then that is an exception. If one of the shape's
 * terminals is bound to a shape that contains / is contained by the shape that
 * is bound to the other terminal, then that is also an exception.
 *
 * @param editor - the editor instance
 * @param startShapeId - the bound shape from the arrow's start
 * @param endShapeId - the bound shape from the arrow's end
 *
 *  @internal */
export declare function getBoundShapeRelationships(editor: Editor, startShapeId?: TLShapeId, endShapeId?: TLShapeId): "double-bound" | "end-contains-start" | "safe" | "start-contains-end";
/**
 * If the arrow terminal point falls outside the bound shape's mask (e.g. when a shape
 * extends beyond a frame boundary and is clipped), clamp the terminal to the mask boundary.
 * Uses the binding anchor point (inside the shape/frame) as the ray origin, since the
 * arrow endpoint may be entirely outside the mask.
 *
 * @internal
 */
export declare function clampArrowTerminalToMask(editor: Editor, point: Vec, terminalHandle: Vec, arrowPageTransform: MatModel, targetShapeInfo?: BoundShapeInfo): void;
//# sourceMappingURL=shared.d.ts.map