import { Vec, VecLike } from '../Vec';
import { Edge2d } from './Edge2d';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Polyline2d extends Geometry2d {
    private _points;
    private _segments?;
    constructor(config: Omit<Geometry2dOptions, 'isFilled' | 'isClosed'> & {
        points: Vec[];
    });
    protected get segments(): Edge2d[];
    getLength(): number;
    getVertices(): Vec[];
    nearestPoint(A: VecLike): Vec;
    hitTestPoint(point: VecLike, margin?: number, hitInside?: boolean): boolean;
    distanceToPoint(point: VecLike, hitInside?: boolean): number;
    hitTestLineSegment(A: VecLike, B: VecLike, distance?: number): boolean;
    getSvgPathData(): string;
}
//# sourceMappingURL=Polyline2d.d.ts.map