import { ExtractShapeByProps } from '@tldraw/tlschema';
import { Geometry2d } from '../../primitives/geometry/Geometry2d';
import { HandleSnapGeometry } from '../managers/SnapManager/HandleSnaps';
import { ShapeUtil, TLResizeInfo } from './ShapeUtil';
/** @public */
export type TLBaseBoxShape = ExtractShapeByProps<{
    h: number;
    w: number;
}>;
/** @public */
export declare abstract class BaseBoxShapeUtil<Shape extends TLBaseBoxShape> extends ShapeUtil<Shape> {
    getGeometry(shape: Shape): Geometry2d;
    onResize(shape: any, info: TLResizeInfo<any>): any;
    getHandleSnapGeometry(shape: Shape): HandleSnapGeometry;
    getInterpolatedProps(startShape: Shape, endShape: Shape, t: number): Shape['props'];
}
//# sourceMappingURL=BaseBoxShapeUtil.d.ts.map