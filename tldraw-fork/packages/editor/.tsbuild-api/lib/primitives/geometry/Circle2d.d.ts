import { Box } from '../Box';
import { Vec, VecLike } from '../Vec';
import { Geometry2d, Geometry2dOptions } from './Geometry2d';
/** @public */
export declare class Circle2d extends Geometry2d {
    config: Omit<Geometry2dOptions, 'isClosed'> & {
        isFilled: boolean;
        radius: number;
        x?: number;
        y?: number;
    };
    private _center;
    private _radius;
    private _x;
    private _y;
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        isFilled: boolean;
        radius: number;
        x?: number;
        y?: number;
    });
    getBounds(): Box;
    getVertices(): Vec[];
    nearestPoint(point: VecLike): Vec;
    distanceToPoint(point: VecLike, hitInside?: boolean): number;
    hitTestPoint(point: VecLike, margin?: number, hitInside?: boolean): boolean;
    hitTestLineSegment(A: VecLike, B: VecLike, distance?: number): boolean;
    getSvgPathData(): string;
}
//# sourceMappingURL=Circle2d.d.ts.map