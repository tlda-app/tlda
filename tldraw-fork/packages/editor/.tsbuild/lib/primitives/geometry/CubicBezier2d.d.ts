import { Vec, VecLike } from '../Vec';
import { Geometry2dFilters, Geometry2dOptions } from './Geometry2d';
import { Polyline2d } from './Polyline2d';
/** @public */
export declare class CubicBezier2d extends Polyline2d {
    private _a;
    private _b;
    private _c;
    private _d;
    private _resolution;
    constructor(config: Omit<Geometry2dOptions, 'isFilled' | 'isClosed'> & {
        start: Vec;
        cp1: Vec;
        cp2: Vec;
        end: Vec;
        resolution?: number;
    });
    getVertices(): Vec[];
    nearestPoint(A: VecLike): Vec;
    distanceToPoint(point: VecLike, _hitInside?: boolean): number;
    getSvgPathData(first?: boolean): string;
    static GetAtT(segment: CubicBezier2d, t: number): Vec;
    getLength(_filters?: Geometry2dFilters, precision?: number): number;
}
//# sourceMappingURL=CubicBezier2d.d.ts.map