import { BoxModel } from '@tldraw/tlschema';
import { Vec, VecLike } from './Vec';
/** @public */
export type BoxLike = BoxModel | Box;
/** @public */
export type SelectionEdge = 'top' | 'right' | 'bottom' | 'left';
/** @public */
export type SelectionCorner = 'top_left' | 'top_right' | 'bottom_right' | 'bottom_left';
/** @public */
export type SelectionHandle = SelectionEdge | SelectionCorner;
/** @public */
export type RotateCorner = 'top_left_rotate' | 'top_right_rotate' | 'bottom_right_rotate' | 'bottom_left_rotate' | 'mobile_rotate';
/** @public */
export declare class Box {
    constructor(x?: number, y?: number, w?: number, h?: number);
    x: number;
    y: number;
    w: number;
    h: number;
    get point(): Vec;
    set point(val: Vec);
    get minX(): number;
    set minX(n: number);
    get left(): number;
    get midX(): number;
    get maxX(): number;
    get right(): number;
    get minY(): number;
    set minY(n: number);
    get top(): number;
    get midY(): number;
    get maxY(): number;
    get bottom(): number;
    get width(): number;
    set width(n: number);
    get height(): number;
    set height(n: number);
    get aspectRatio(): number;
    get center(): Vec;
    set center(v: Vec);
    get corners(): Vec[];
    get cornersAndCenter(): Vec[];
    get sides(): Array<[Vec, Vec]>;
    get size(): Vec;
    isValid(): boolean;
    toFixed(): this;
    setTo(B: Box): this;
    set(x?: number, y?: number, w?: number, h?: number): this;
    expand(A: Box): this;
    expandBy(n: number): this;
    scale(n: number): this;
    clone(): Box;
    translate(delta: VecLike): this;
    snapToGrid(size: number): void;
    collides(B: Box): boolean;
    contains(B: Box): boolean;
    includes(B: Box): boolean;
    containsPoint(V: VecLike, margin?: number): boolean;
    getHandlePoint(handle: SelectionCorner | SelectionEdge): Vec;
    toJson(): BoxModel;
    resize(handle: SelectionCorner | SelectionEdge | string, dx: number, dy: number): void;
    union(box: BoxModel): this;
    static From(box: BoxModel): Box;
    static FromCenter(center: VecLike, size: VecLike): Box;
    static FromPoints(points: VecLike[]): Box;
    static Expand(A: Box, B: Box): Box;
    static ExpandBy(A: Box, n: number): Box;
    static Collides(A: Box, B: Box): boolean;
    static Contains(A: Box, B: Box): boolean;
    static ContainsApproximately(A: Box, B: Box, precision?: number): boolean;
    static Includes(A: Box, B: Box): boolean;
    static ContainsPoint(A: Box, B: VecLike, margin?: number): boolean;
    static Common(boxes: Box[]): Box;
    static Sides(A: Box, inset?: number): Vec[][];
    static Resize(box: Box, handle: SelectionCorner | SelectionEdge | string, dx: number, dy: number, isAspectRatioLocked?: boolean): {
        box: Box;
        scaleX: number;
        scaleY: number;
    };
    equals(other: Box | BoxModel): boolean;
    static Equals(a: Box | BoxModel, b: Box | BoxModel): boolean;
    zeroFix(): this;
    static ZeroFix(other: Box | BoxModel): Box;
}
/** @public */
export declare function flipSelectionHandleY(handle: SelectionHandle): "bottom" | "bottom_left" | "bottom_right" | "left" | "right" | "top" | "top_left" | "top_right";
/** @public */
export declare function flipSelectionHandleX(handle: SelectionHandle): "bottom" | "bottom_left" | "bottom_right" | "left" | "right" | "top" | "top_left" | "top_right";
/** @public */
export declare function rotateSelectionHandle(handle: SelectionHandle, rotation: number): SelectionHandle;
/** @public */
export declare function isSelectionCorner(selection: string): selection is SelectionCorner;
/** @public */
export declare const ROTATE_CORNER_TO_SELECTION_CORNER: {
    readonly top_left_rotate: "top_left";
    readonly top_right_rotate: "top_right";
    readonly bottom_right_rotate: "bottom_right";
    readonly bottom_left_rotate: "bottom_left";
    readonly mobile_rotate: "top_left";
};
//# sourceMappingURL=Box.d.ts.map