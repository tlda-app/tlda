import { Box } from '../Box';
import { Vec, VecLike } from '../Vec';
import { Edge2d } from './Edge2d';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Ellipse2d extends Geometry2d {
    config: Omit<Geometry2dOptions, 'isClosed'> & {
        height: number;
        width: number;
    };
    private _w;
    private _h;
    private _edges?;
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        height: number;
        width: number;
    });
    get edges(): Edge2d[];
    getVertices(): any[];
    nearestPoint(A: VecLike): Vec;
    distanceToPoint(point: VecLike, hitInside?: boolean): number;
    hitTestLineSegment(A: VecLike, B: VecLike): boolean;
    getBounds(): Box;
    getLength(): number;
    getSvgPathData(first?: boolean): string;
}
//# sourceMappingURL=Ellipse2d.d.ts.map