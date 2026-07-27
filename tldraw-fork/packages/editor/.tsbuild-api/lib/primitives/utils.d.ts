import { Vec, VecLike } from './Vec';
/** @public */
export declare function precise(A: VecLike): string;
/** @public */
export declare function average(A: VecLike, B: VecLike): string;
/** @public */
export declare const PI: number;
/** @public */
export declare const HALF_PI: number;
/** @public */
export declare const PI2: number;
/** @public */
export declare const SIN: (x: number) => number;
/**
 * Clamp a value into a range.
 *
 * @example
 *
 * ```ts
 * const A = clamp(0, 1) // 1
 * ```
 *
 * @param n - The number to clamp.
 * @param min - The minimum value.
 * @public
 */
export declare function clamp(n: number, min: number): number;
/**
 * Clamp a value into a range.
 *
 * @example
 *
 * ```ts
 * const A = clamp(0, 1, 10) // 1
 * const B = clamp(11, 1, 10) // 10
 * const C = clamp(5, 1, 10) // 5
 * ```
 *
 * @param n - The number to clamp.
 * @param min - The minimum value.
 * @param max - The maximum value.
 * @public
 */
export declare function clamp(n: number, min: number, max: number): number;
/**
 * Get a number to a precision.
 *
 * @param n - The number.
 * @param precision - The precision.
 * @public
 */
export declare function toPrecision(n: number, precision?: number): number;
/**
 * Whether two numbers numbers a and b are approximately equal.
 *
 * @param a - The first point.
 * @param b - The second point.
 * @public
 */
export declare function approximately(a: number, b: number, precision?: number): boolean;
/**
 * Whether a number is approximately less than or equal to another number.
 *
 * @param a - The first number.
 * @param b - The second number.
 * @public
 */
export declare function approximatelyLte(a: number, b: number, precision?: number): boolean;
/**
 * Find the approximate perimeter of an ellipse.
 *
 * @param rx - The ellipse's x radius.
 * @param ry - The ellipse's y radius.
 * @public
 */
export declare function perimeterOfEllipse(rx: number, ry: number): number;
/**
 * @param a - Any angle in radians
 * @returns A number between 0 and 2 * PI
 * @public
 */
export declare function canonicalizeRotation(a: number): number;
/**
 * Get the clockwise angle distance between two angles.
 *
 * @param a0 - The first angle.
 * @param a1 - The second angle.
 * @public
 */
export declare function clockwiseAngleDist(a0: number, a1: number): number;
/**
 * Get the counter-clockwise angle distance between two angles.
 *
 * @param a0 - The first angle.
 * @param a1 - The second angle.
 * @public
 */
export declare function counterClockwiseAngleDist(a0: number, a1: number): number;
/**
 * Get the short angle distance between two angles.
 *
 * @param a0 - The first angle.
 * @param a1 - The second angle.
 * @public
 */
export declare function shortAngleDist(a0: number, a1: number): number;
/**
 * Clamp radians within 0 and 2PI
 *
 * @param r - The radian value.
 * @public
 */
export declare function clampRadians(r: number): number;
/**
 * Clamp rotation to even segments.
 *
 * @param r - The rotation in radians.
 * @param segments - The number of segments.
 * @public
 */
export declare function snapAngle(r: number, segments: number): number;
/**
 * Checks whether two angles are approximately at right-angles or parallel to each other
 *
 * @param a - Angle a (radians)
 * @param b - Angle b (radians)
 * @returns True iff the angles are approximately at right-angles or parallel to each other
 * @public
 */
export declare function areAnglesCompatible(a: number, b: number): boolean;
/**
 * Convert degrees to radians.
 *
 * @param d - The degree in degrees.
 * @public
 */
export declare function degreesToRadians(d: number): number;
/**
 * Convert radians to degrees.
 *
 * @param r - The degree in radians.
 * @public
 */
export declare function radiansToDegrees(r: number): number;
/**
 * Get a point on the perimeter of a circle.
 *
 * @param center - The center of the circle.
 * @param r - The radius of the circle.
 * @param a - The angle in radians.
 * @public
 */
export declare function getPointOnCircle(center: VecLike, r: number, a: number): Vec;
/** @public */
export declare function getPolygonVertices(width: number, height: number, sides: number): Vec[];
/**
 * @param a0 - The start point in the A range
 * @param a1 - The end point in the A range
 * @param b0 - The start point in the B range
 * @param b1 - The end point in the B range
 * @returns True if the ranges overlap
 * @public
 */
export declare function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean;
/**
 * Finds the intersection of two ranges.
 *
 * @param a0 - The start point in the A range
 * @param a1 - The end point in the A range
 * @param b0 - The start point in the B range
 * @param b1 - The end point in the B range
 * @returns The intersection of the ranges, or null if no intersection
 * @public
 */
export declare function rangeIntersection(a0: number, a1: number, b0: number, b1: number): [number, number] | null;
/**
 * Get whether a point is inside of a polygon.
 *
 * ```ts
 * const result = pointInPolygon(myPoint, myPoints)
 * ```
 *
 * @public
 */
export declare function pointInPolygon(A: VecLike, points: VecLike[]): boolean;
/**
 * The DOM likes values to be fixed to 3 decimal places
 *
 * @public
 */
export declare function toDomPrecision(v: number): number;
/**
 * @public
 */
export declare function toFixed(v: number): number;
/**
 * Check if a float is safe to use. ie: Not too big or small.
 * @public
 */
export declare function isSafeFloat(n: number): boolean;
/**
 * Get the angle of a point on an arc.
 * @param fromAngle - The angle from center to arc's start point (A) on the circle
 * @param toAngle - The angle from center to arc's end point (B) on the circle
 * @param direction - The direction of the arc (1 = counter-clockwise, -1 = clockwise)
 * @returns The distance in radians between the two angles according to the direction
 * @public
 */
export declare function angleDistance(fromAngle: number, toAngle: number, direction: number): number;
/**
 * Returns the t value of the point on the arc.
 *
 * @param mAB - The measure of the arc from A to B, negative if counter-clockwise
 * @param A - The angle from center to arc's start point (A) on the circle
 * @param B - The angle from center to arc's end point (B) on the circle
 * @param P - The angle on the circle (P) to find the t value for
 *
 * @returns The t value of the point on the arc, with 0 being the start and 1 being the end
 *
 * @public
 */
export declare function getPointInArcT(mAB: number, A: number, B: number, P: number): number;
/**
 * Get the measure of an arc.
 *
 * @param A - The angle from center to arc's start point (A) on the circle
 * @param B - The angle from center to arc's end point (B) on the circle
 * @param sweepFlag - 1 if the arc is clockwise, 0 if counter-clockwise
 * @param largeArcFlag - 1 if the arc is greater than 180 degrees, 0 if less than 180 degrees
 *
 * @returns The measure of the arc, negative if counter-clockwise
 *
 * @public
 */
export declare function getArcMeasure(A: number, B: number, sweepFlag: number, largeArcFlag: number): number;
/**
 * Get the center of a circle from three points.
 *
 * @param a - The first point
 * @param b - The second point
 * @param c - The third point
 *
 * @returns The center of the circle or null if the points are collinear
 *
 * @public
 */
export declare function centerOfCircleFromThreePoints(a: VecLike, b: VecLike, c: VecLike): null | Vec;
/** @public */
export declare function getPointsOnArc(startPoint: VecLike, endPoint: VecLike, center: null | VecLike, radius: number, numPoints: number): Vec[];
//# sourceMappingURL=utils.d.ts.map