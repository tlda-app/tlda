import { TLShape } from '@tldraw/tlschema';
import { Vec } from '../../primitives/Vec';
import { BaseBoxShapeUtil, TLBaseBoxShape } from './BaseBoxShapeUtil';
import { TLDragShapesInInfo, TLDragShapesOutInfo } from './ShapeUtil';
/**
 * A base class for frame-like shapes — containers that clip their children,
 * require full-brush selection, block erasure from inside, and support
 * drag-and-drop reparenting.
 *
 * Extending this class is the easiest way to create a custom frame-like shape.
 * It provides sensible defaults for all frame-like behaviors:
 *
 * - `isFrameLike()` returns `true`
 * - `providesBackgroundForChildren()` returns `true`
 * - `canReceiveNewChildrenOfType()` returns `true` unless the container is locked
 * - `canRemoveChildrenOfType()` returns `true` unless the container is locked
 * - `getClipPath()` returns the shape geometry's vertices
 * - `onDragShapesIn()` reparents shapes into the frame (with index restoration)
 * - `onDragShapesOut()` reparents shapes back to the page
 *
 * All methods can be overridden for custom behavior.
 *
 * @example
 * ```ts
 * class MyContainerUtil extends BaseFrameLikeShapeUtil<MyContainerShape> {
 *   static override type = 'my-container' as const
 *   static override props = myContainerShapeProps
 *
 *   override getDefaultProps() {
 *     return { w: 300, h: 200 }
 *   }
 *
 *   override component(shape: MyContainerShape) {
 *     return <SVGContainer>...</SVGContainer>
 *   }
 *
 *   override getIndicatorPath(shape: MyContainerShape) {
 *     const path = new Path2D()
 *     path.rect(0, 0, shape.props.w, shape.props.h)
 *     return path
 *   }
 * }
 * ```
 *
 * @public
 */
export declare abstract class BaseFrameLikeShapeUtil<Shape extends TLBaseBoxShape> extends BaseBoxShapeUtil<Shape> {
    isFrameLike(_shape: Shape): boolean;
    providesBackgroundForChildren(): boolean;
    canReceiveNewChildrenOfType(shape: Shape, _type: TLShape['type']): boolean;
    canRemoveChildrenOfType(shape: Shape, _type: TLShape['type']): boolean;
    getClipPath(shape: Shape): Vec[] | undefined;
    onDragShapesIn(shape: Shape, draggingShapes: TLShape[], { initialParentIds, initialIndices }: TLDragShapesInInfo): void;
    onDragShapesOut(shape: Shape, draggingShapes: TLShape[], info: TLDragShapesOutInfo): void;
}
//# sourceMappingURL=BaseFrameLikeShapeUtil.d.ts.map