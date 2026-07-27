import { Box } from '../Box';
import { Geometry2dOptions } from './Geometry2d';
import { Polygon2d } from './Polygon2d';
/** @public */
export declare class Rectangle2d extends Polygon2d {
    private _x;
    private _y;
    private _w;
    private _h;
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        height: number;
        width: number;
        x?: number;
        y?: number;
    });
    getBounds(): Box;
    getSvgPathData(): string;
    private negativeZeroFix;
}
//# sourceMappingURL=Rectangle2d.d.ts.map