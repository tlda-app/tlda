import { Box } from './Box';
import { Vec, VecLike } from './Vec';
/**
 * Find the intersection between a line segment and a line segment.
 *
 * @param a1 - The first segment's first point.
 * @param a2 - The first segment's second point.
 * @param b1 - The second segment's first point.
 * @param b2 - The second segment's second point.
 * @public
 */
export declare function intersectLineSegmentLineSegment(a1: VecLike, a2: VecLike, b1: VecLike, b2: VecLike, precision?: number): null | Vec;
/**
 * Find the intersections between a line segment and a circle.
 *
 * @param a1 - The segment's first point.
 * @param a2 - The segment's second point.
 * @param c - The circle's center.
 * @param r - The circle's radius.
 * @public
 */
export declare function intersectLineSegmentCircle(a1: VecLike, a2: VecLike, c: VecLike, r: number): null | VecLike[];
/**
 * Find the intersections between a line segment and a polyline.
 *
 * @param a1 - The segment's first point.
 * @param a2 - The segment's second point.
 * @param points - The points in the polyline.
 * @public
 */
export declare function intersectLineSegmentPolyline(a1: VecLike, a2: VecLike, points: VecLike[]): null | VecLike[];
/**
 * Find the intersections between a line segment and a closed polygon.
 *
 * @param a1 - The segment's first point.
 * @param a2 - The segment's second point.
 * @param points - The points in the polygon.
 * @public
 */
export declare function intersectLineSegmentPolygon(a1: VecLike, a2: VecLike, points: VecLike[]): null | VecLike[];
/**
 * Find the intersections between a circle and a circle.
 *
 * @param c1 - The first circle's center.
 * @param r1 - The first circle's radius.
 * @param c2 - The second circle's center.
 * @param r2 - The second circle's radius.
 * @public
 */
export declare function intersectCircleCircle(c1: VecLike, r1: number, c2: VecLike, r2: number): Vec[];
/**
 * Find the intersections between a circle and a bounding box.
 *
 * @param c - The circle's center.
 * @param r - The circle's radius.
 * @param points - The points in the polygon.
 * @public
 */
export declare function intersectCirclePolygon(c: VecLike, r: number, points: VecLike[]): null | VecLike[];
/**
 * Find the intersections between a circle and a bounding box.
 *
 * @param c - The circle's center.
 * @param r - The circle's radius.
 * @param points - The points in the polyline.
 * @public
 */
export declare function intersectCirclePolyline(c: VecLike, r: number, points: VecLike[]): null | VecLike[];
/**
 * Find the intersections between a polygon and a bounding box.
 *
 * @public
 */
export declare function intersectPolygonBounds(points: VecLike[], bounds: Box): null | VecLike[];
/** @public */
export declare function linesIntersect(A: VecLike, B: VecLike, C: VecLike, D: VecLike): boolean;
/**
 * Create a new convex polygon as the intersection of two convex polygons.
 *
 * @param polygonA - An array of points representing the first polygon.
 * @param polygonB - An array of points representing the second polygon.
 * @public
 */
export declare function intersectPolygonPolygon(polygonA: VecLike[], polygonB: VecLike[]): null | VecLike[];
/**
 * Find all the points where `polyA` and `polyB` intersect and returns them in an undefined order.
 * To find the polygon that's the intersection of polyA and polyB, use `intersectPolygonPolygon`
 * instead, which orders the points and includes internal points.
 *
 * @param polyA - The first polygon.
 * @param polyB - The second polygon.
 * @param isAClosed - Whether `polyA` is a closed polygon or a polyline.
 * @param isBClosed - Whether `polyB` is a closed polygon or a polyline.
 * @public
 */
export declare function intersectPolys(polyA: VecLike[], polyB: VecLike[], isAClosed: boolean, isBClosed: boolean): VecLike[];
/** @public */
export declare function polygonsIntersect(a: VecLike[], b: VecLike[]): boolean;
/** @public */
export declare function polygonIntersectsPolyline(polygon: VecLike[], polyline: VecLike[]): boolean;
//# sourceMappingURL=intersect.d.ts.map