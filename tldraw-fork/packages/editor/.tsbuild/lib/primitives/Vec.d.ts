import { VecModel } from '@tldraw/tlschema';
/** @public */
export type VecLike = Vec | VecModel;
/** @public */
export declare class Vec {
    x: number;
    y: number;
    z: number;
    constructor(x?: number, y?: number, z?: number);
    get pressure(): number;
    set(x?: number, y?: number, z?: number): this;
    setTo({ x, y, z }: VecLike): this;
    rot(r: number): this;
    rotWith(C: VecLike, r: number): this;
    clone(): Vec;
    sub(V: VecLike): this;
    subXY(x: number, y: number): this;
    subScalar(n: number): this;
    add(V: VecLike): this;
    addXY(x: number, y: number): this;
    addScalar(n: number): this;
    clamp(min: number, max?: number): this;
    div(t: number): this;
    divV(V: VecLike): this;
    mul(t: number): this;
    mulV(V: VecLike): this;
    abs(): this;
    nudge(B: VecLike, distance: number): this;
    neg(): this;
    cross(V: VecLike): this;
    dpr(V: VecLike): number;
    cpr(V: VecLike): number;
    len2(): number;
    len(): number;
    pry(V: VecLike): number;
    per(): this;
    uni(): this;
    tan(V: VecLike): Vec;
    dist(V: VecLike): number;
    distanceToLineSegment(A: VecLike, B: VecLike): number;
    slope(B: VecLike): number;
    snapToGrid(gridSize: number): this;
    angle(B: VecLike): number;
    toAngle(): number;
    lrp(B: VecLike, t: number): Vec;
    equals(B: VecLike): boolean;
    equalsXY(x: number, y: number): boolean;
    toFixed(): this;
    toString(): string;
    toJson(): VecModel;
    toArray(): number[];
    static Add(A: VecLike, B: VecLike): Vec;
    static AddXY(A: VecLike, x: number, y: number): Vec;
    static Sub(A: VecLike, B: VecLike): Vec;
    static SubXY(A: VecLike, x: number, y: number): Vec;
    static AddScalar(A: VecLike, n: number): Vec;
    static SubScalar(A: VecLike, n: number): Vec;
    static Div(A: VecLike, t: number): Vec;
    static Mul(A: VecLike, t: number): Vec;
    static DivV(A: VecLike, B: VecLike): Vec;
    static MulV(A: VecLike, B: VecLike): Vec;
    static Neg(A: VecLike): Vec;
    /**
     * Get the perpendicular vector to A.
     */
    static Per(A: VecLike): Vec;
    static Abs(A: VecLike): Vec;
    static Dist(A: VecLike, B: VecLike): number;
    static ManhattanDist(A: VecLike, B: VecLike): number;
    static DistMin(A: VecLike, B: VecLike, n: number): boolean;
    static Dist2(A: VecLike, B: VecLike): number;
    /**
     * Dot product of two vectors which is used to calculate the angle between them.
     */
    static Dpr(A: VecLike, B: VecLike): number;
    static Cross(A: VecLike, V: VecLike): Vec;
    /**
     * Cross product of two vectors which is used to calculate the area of a parallelogram.
     */
    static Cpr(A: VecLike, B: VecLike): number;
    static Len2(A: VecLike): number;
    static Len(A: VecLike): number;
    /**
     * Get the projection of A onto B.
     */
    static Pry(A: VecLike, B: VecLike): number;
    /**
     * Get the unit vector of A.
     */
    static Uni(A: VecLike): Vec;
    static Tan(A: VecLike, B: VecLike): Vec;
    static Min(A: VecLike, B: VecLike): Vec;
    static Max(A: VecLike, B: VecLike): Vec;
    static From({ x, y, z }: VecModel): Vec;
    static FromArray(v: number[]): Vec;
    static Rot(A: VecLike, r?: number): Vec;
    static RotWith(A: VecLike, C: VecLike, r: number): Vec;
    /**
     * Get the nearest point on a line with a known unit vector that passes through point A
     *
     * ```ts
     * Vec.nearestPointOnLineThroughPoint(A, u, Point)
     * ```
     *
     * @param A - Any point on the line
     * @param u - The unit vector for the line.
     * @param P - A point not on the line to test.
     */
    static NearestPointOnLineThroughPoint(A: VecLike, u: VecLike, P: VecLike): Vec;
    static NearestPointOnLineSegment(A: VecLike, B: VecLike, P: VecLike, clamp?: boolean): Vec;
    static DistanceToLineThroughPoint(A: VecLike, u: VecLike, P: VecLike): number;
    static DistanceToLineSegment(A: VecLike, B: VecLike, P: VecLike, clamp?: boolean): number;
    static Snap(A: VecLike, step?: number): Vec;
    static Cast(A: VecLike): Vec;
    static Slope(A: VecLike, B: VecLike): number;
    static IsNaN(A: VecLike): boolean;
    static IsFinite(A: VecLike): boolean;
    /**
     * Get the angle from position A to position B.
     */
    static Angle(A: VecLike, B: VecLike): number;
    /**
     * Get the angle between vector A and vector B. This will return the smallest angle between the
     * two vectors, between -π and π. The sign indicates direction of angle.
     */
    static AngleBetween(A: VecLike, B: VecLike): number;
    /**
     * Linearly interpolate between two points.
     * @param A - The first point.
     * @param B - The second point.
     * @param t - The interpolation value between 0 and 1.
     * @returns The interpolated point.
     */
    static Lrp(A: VecLike, B: VecLike, t: number): Vec;
    static Med(A: VecLike, B: VecLike): Vec;
    static Equals(A: VecLike, B: VecLike): boolean;
    static EqualsXY(A: VecLike, x: number, y: number): boolean;
    static Clockwise(A: VecLike, B: VecLike, C: VecLike): boolean;
    static Rescale(A: VecLike, n: number): Vec;
    static ScaleWithOrigin(A: VecLike, scale: number, origin: VecLike): Vec;
    static ToFixed(A: VecLike): Vec;
    static ToInt(A: VecLike): Vec;
    static ToCss(A: VecLike): string;
    static Nudge(A: VecLike, B: VecLike, distance: number): Vec;
    static ToString(A: VecLike): string;
    static ToAngle(A: VecLike): number;
    static FromAngle(r: number, length?: number): Vec;
    static ToArray(A: VecLike): number[];
    static ToJson(A: VecLike): {
        x: number;
        y: number;
        z: number | undefined;
    };
    static Average(arr: VecLike[]): Vec;
    static Clamp(A: Vec, min: number, max?: number): Vec;
    /**
     * Get an array of points (with simulated pressure) between two points.
     *
     * @param A - The first point.
     * @param B - The second point.
     * @param steps - The number of points to return.
     * @param ease - The easing to use.
     */
    static PointsBetween(A: VecModel, B: VecModel, steps?: number, ease?: (t: number) => number): Vec[];
    static SnapToGrid(A: VecLike, gridSize?: number): Vec;
}
//# sourceMappingURL=Vec.d.ts.map