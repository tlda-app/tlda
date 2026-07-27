import { Vec, VecLike } from '../Vec';
import { CubicBezier2d } from './CubicBezier2d';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class CubicSpline2d extends Geometry2d {
    private _points;
    constructor(config: Omit<Geometry2dOptions, 'isClosed' | 'isFilled'> & {
        points: Vec[];
    });
    private _segments?;
    get segments(): CubicBezier2d[];
    getLength(): number;
    getVertices(): Vec[];
    nearestPoint(A: VecLike): Vec;
    distanceToPoint(point: VecLike, _hitInside?: boolean): number;
    hitTestLineSegment(A: VecLike, B: VecLike): boolean;
    getSvgPathData(): string;
}
//# sourceMappingURL=CubicSpline2d.d.ts.map