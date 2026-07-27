import { Box } from '../Box';
import { Vec, VecLike } from '../Vec';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Stadium2d extends Geometry2d {
    config: Omit<Geometry2dOptions, 'isClosed'> & {
        height: number;
        width: number;
    };
    private _w;
    private _h;
    private _a;
    private _b;
    private _c;
    private _d;
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        height: number;
        width: number;
    });
    nearestPoint(A: VecLike): Vec;
    distanceToPoint(point: VecLike, hitInside?: boolean): number;
    hitTestLineSegment(A: VecLike, B: VecLike): boolean;
    getVertices(): Vec[];
    getBounds(): Box;
    getLength(): number;
    getSvgPathData(): string;
}
//# sourceMappingURL=Stadium2d.d.ts.map