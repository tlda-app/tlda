import { Vec, VecLike } from '../Vec';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Arc2d extends Geometry2d {
    private _center;
    private _radius;
    private _start;
    private _end;
    private _largeArcFlag;
    private _sweepFlag;
    private _measure;
    private _angleStart;
    private _angleEnd;
    constructor(config: Omit<Geometry2dOptions, 'isClosed' | 'isFilled'> & {
        center: Vec;
        end: Vec;
        largeArcFlag: number;
        start: Vec;
        sweepFlag: number;
    });
    nearestPoint(point: VecLike): Vec;
    hitTestLineSegment(A: VecLike, B: VecLike): boolean;
    getVertices(): Vec[];
    getSvgPathData(first?: boolean): string;
    getLength(): number;
}
//# sourceMappingURL=Arc2d.d.ts.map