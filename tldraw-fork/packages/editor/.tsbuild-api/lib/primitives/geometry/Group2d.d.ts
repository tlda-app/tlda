import { Mat } from '../Mat';
import { Vec, VecLike } from '../Vec';
import { Geometry2d, Geometry2dFilters, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Group2d extends Geometry2d {
    children: Geometry2d[];
    ignoredChildren: Geometry2d[];
    constructor(config: Omit<Geometry2dOptions, 'isClosed' | 'isFilled'> & {
        children: Geometry2d[];
    });
    getVertices(filters: Geometry2dFilters): Vec[];
    nearestPoint(point: VecLike, filters?: Geometry2dFilters): Vec;
    distanceToPoint(point: VecLike, hitInside?: boolean, filters?: Geometry2dFilters): number;
    hitTestPoint(point: VecLike, margin: number, hitInside: boolean, filters?: Geometry2dFilters): boolean;
    hitTestLineSegment(A: VecLike, B: VecLike, zoom: number, filters?: Geometry2dFilters): boolean;
    intersectLineSegment(A: VecLike, B: VecLike, filters?: Geometry2dFilters): VecLike[];
    intersectCircle(center: VecLike, radius: number, filters?: Geometry2dFilters): VecLike[];
    getBoundsVertices(): Vec[];
    intersectPolygon(polygon: VecLike[], filters?: Geometry2dFilters): VecLike[];
    intersectPolyline(polyline: VecLike[], filters?: Geometry2dFilters): VecLike[];
    interpolateAlongEdge(t: number, filters?: Geometry2dFilters): Vec;
    uninterpolateAlongEdge(point: VecLike, filters?: Geometry2dFilters): number;
    transform(transform: Mat): Geometry2d;
    getArea(): number;
    toSimpleSvgPath(): string;
    getLength(filters?: Geometry2dFilters): number;
    getSvgPathData(): string;
    overlapsPolygon(polygon: VecLike[]): boolean;
}
//# sourceMappingURL=Group2d.d.ts.map