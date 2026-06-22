import { Vec, VecLike } from '../Vec';
import { Geometry2d } from './Geometry2d';
/** @public */
export declare class Edge2d extends Geometry2d {
    private _start;
    private _end;
    private _dx;
    private _dy;
    private _len2;
    constructor(config: {
        end: Vec;
        start: Vec;
    });
    getLength(): number;
    getVertices(): Vec[];
    nearestPoint(point: VecLike): Vec;
    distanceToPoint(point: VecLike, _hitInside?: boolean): number;
    getSvgPathData(first?: boolean): string;
}
//# sourceMappingURL=Edge2d.d.ts.map