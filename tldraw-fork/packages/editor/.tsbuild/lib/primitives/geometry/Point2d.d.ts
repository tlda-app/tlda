import { Vec, VecLike } from '../Vec';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Point2d extends Geometry2d {
    private _point;
    constructor(config: Omit<Geometry2dOptions, 'isClosed' | 'isFilled'> & {
        margin: number;
        point: Vec;
    });
    getVertices(): Vec[];
    nearestPoint(): Vec;
    hitTestLineSegment(A: VecLike, B: VecLike, margin: number): boolean;
    getSvgPathData(): string;
}
//# sourceMappingURL=Point2d.d.ts.map