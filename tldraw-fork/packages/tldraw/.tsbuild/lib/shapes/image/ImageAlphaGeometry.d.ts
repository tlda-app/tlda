import { Ellipse2d, Geometry2dOptions, Rectangle2d, VecLike } from '@tldraw/editor';
import { ImageAlphaGeometryConfig } from './ImageAlphaCache';
/** @internal */
export declare class ImageRectangle2d extends Rectangle2d {
    private alphaConfig;
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        x?: number;
        y?: number;
        width: number;
        height: number;
    } & ImageAlphaGeometryConfig);
    hitTestPoint(point: VecLike, margin?: number, hitInside?: boolean): boolean;
    ignoreHit(point: VecLike): boolean;
}
/** @internal */
export declare class ImageEllipse2d extends Ellipse2d {
    private alphaConfig;
    constructor(config: Omit<Geometry2dOptions, 'isClosed'> & {
        width: number;
        height: number;
    } & ImageAlphaGeometryConfig);
    hitTestPoint(point: VecLike, margin?: number, hitInside?: boolean): boolean;
    ignoreHit(point: VecLike): boolean;
}
//# sourceMappingURL=ImageAlphaGeometry.d.ts.map