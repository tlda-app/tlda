import { Box } from '../Box';
import { MatModel } from '../Mat';
import { Vec, VecLike } from '../Vec';
/**
 * Filter geometry within a group.
 *
 * Filters are ignored when called directly on primitive geometries, but can be used to narrow down
 * the results of an operation on `Group2d` geometries.
 *
 * @public
 */
export interface Geometry2dFilters {
    readonly includeLabels?: boolean;
    readonly includeInternal?: boolean;
}
/** @public */
export declare const Geometry2dFilters: {
    EXCLUDE_NON_STANDARD: Geometry2dFilters;
    INCLUDE_ALL: Geometry2dFilters;
    EXCLUDE_LABELS: Geometry2dFilters;
    EXCLUDE_INTERNAL: Geometry2dFilters;
};
/** @public */
export interface TransformedGeometry2dOptions {
    isLabel?: boolean;
    isEmptyLabel?: boolean;
    isInternal?: boolean;
    debugColor?: string;
    ignore?: boolean;
    excludeFromShapeBounds?: boolean;
}
/** @public */
export interface Geometry2dOptions extends TransformedGeometry2dOptions {
    isFilled: boolean;
    isClosed: boolean;
}
/** @public */
export declare abstract class Geometry2d {
    isFilled: boolean;
    isClosed: boolean;
    isLabel: boolean;
    isEmptyLabel: boolean;
    isInternal: boolean;
    excludeFromShapeBounds: boolean;
    debugColor?: string;
    ignore?: boolean;
    constructor(opts: Geometry2dOptions);
    isExcludedByFilter(filters?: Geometry2dFilters): boolean;
    abstract getVertices(filters: Geometry2dFilters): Vec[];
    abstract nearestPoint(point: VecLike, _filters?: Geometry2dFilters): Vec;
    hitTestPoint(point: VecLike, margin?: number, hitInside?: boolean, _filters?: Geometry2dFilters): boolean;
    distanceToPoint(point: VecLike, hitInside?: boolean, filters?: Geometry2dFilters): number;
    distanceToLineSegment(A: VecLike, B: VecLike, filters?: Geometry2dFilters): number;
    hitTestLineSegment(A: VecLike, B: VecLike, distance?: number, filters?: Geometry2dFilters): boolean;
    intersectLineSegment(A: VecLike, B: VecLike, _filters?: Geometry2dFilters): VecLike[];
    intersectCircle(center: VecLike, radius: number, _filters?: Geometry2dFilters): VecLike[];
    intersectPolygon(polygon: VecLike[], _filters?: Geometry2dFilters): VecLike[];
    intersectPolyline(polyline: VecLike[], _filters?: Geometry2dFilters): VecLike[];
    /**
     * Find a point along the edge of the geometry that is a fraction `t` along the entire way round.
     */
    interpolateAlongEdge(t: number, _filters?: Geometry2dFilters): Vec;
    /**
     * Take `point`, find the closest point to it on the edge of the geometry, and return how far
     * along the edge it is as a fraction of the total length.
     */
    uninterpolateAlongEdge(point: VecLike, _filters?: Geometry2dFilters): number;
    isPointInBounds(point: VecLike, margin?: number): boolean;
    overlapsPolygon(_polygon: VecLike[]): boolean;
    transform(transform: MatModel, opts?: TransformedGeometry2dOptions): Geometry2d;
    private _vertices;
    get vertices(): Vec[];
    getBoundsVertices(): Vec[];
    private _boundsVertices;
    get boundsVertices(): Vec[];
    getBounds(): Box;
    private _bounds;
    get bounds(): Box;
    get center(): Vec;
    private _area;
    get area(): number;
    getArea(): number;
    toSimpleSvgPath(): string;
    private _length?;
    get length(): number;
    getLength(_filters?: Geometry2dFilters): number;
    /**
     * Called after a hit test succeeds. Return `true` to reject the hit and allow
     * shapes behind this one to be selected instead (e.g. transparent image pixels).
     */
    ignoreHit(_point: VecLike): boolean;
    abstract getSvgPathData(first: boolean): string;
}
/** @public */
export declare class TransformedGeometry2d extends Geometry2d {
    private readonly geometry;
    private readonly matrix;
    private readonly inverse;
    private readonly decomposed;
    constructor(geometry: Geometry2d, matrix: MatModel, opts?: TransformedGeometry2dOptions);
    getVertices(filters: Geometry2dFilters): Vec[];
    getBoundsVertices(): Vec[];
    nearestPoint(point: VecLike, filters?: Geometry2dFilters): Vec;
    hitTestPoint(point: VecLike, margin?: number, hitInside?: boolean, filters?: Geometry2dFilters): boolean;
    distanceToPoint(point: VecLike, hitInside?: boolean, filters?: Geometry2dFilters): number;
    distanceToLineSegment(A: VecLike, B: VecLike, filters?: Geometry2dFilters): number;
    hitTestLineSegment(A: VecLike, B: VecLike, distance?: number, filters?: Geometry2dFilters): boolean;
    intersectLineSegment(A: VecLike, B: VecLike, filters?: Geometry2dFilters): Vec[];
    intersectCircle(center: VecLike, radius: number, filters?: Geometry2dFilters): Vec[];
    intersectPolygon(polygon: VecLike[], filters?: Geometry2dFilters): VecLike[];
    intersectPolyline(polyline: VecLike[], filters?: Geometry2dFilters): VecLike[];
    ignoreHit(point: VecLike): boolean;
    transform(transform: MatModel, opts?: TransformedGeometry2dOptions): Geometry2d;
    getSvgPathData(): string;
}
//# sourceMappingURL=Geometry2d.d.ts.map