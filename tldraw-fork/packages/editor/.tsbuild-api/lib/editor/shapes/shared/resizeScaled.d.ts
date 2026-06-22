import { TLBaseShape } from '@tldraw/tlschema';
import { TLResizeInfo } from '../ShapeUtil';
/**
 * Resize a shape that has a scale prop.
 *
 * @param shape - The shape to resize
 * @param info - The resize info
 *
 * @public */
export declare function resizeScaled(shape: TLBaseShape<any, {
    scale: number;
}>, { initialBounds, scaleX, scaleY, newPoint, handle }: TLResizeInfo<any>): {
    props: {
        scale: number;
    };
    x: number;
    y: number;
};
//# sourceMappingURL=resizeScaled.d.ts.map