import { Vec } from '../Vec';
import { Geometry2dOptions } from './Geometry2d';
import { Polyline2d } from './Polyline2d';
/** @public */
export declare class Polygon2d extends Polyline2d {
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        points: Vec[];
    });
}
//# sourceMappingURL=Polygon2d.d.ts.map