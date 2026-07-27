import { VecModel } from '@tldraw/tlschema';
import { Box } from '../../../primitives/Box';
import { TLResizeHandle } from '../../types/selection-types';
import type { TLBaseBoxShape } from '../BaseBoxShapeUtil';
import { TLResizeMode } from '../ShapeUtil';
/** @public */
export interface ResizeBoxOptions {
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
}
/** @public */
export declare function resizeBox<T extends TLBaseBoxShape>(shape: T, info: {
    newPoint: VecModel;
    handle: TLResizeHandle;
    mode: TLResizeMode;
    scaleX: number;
    scaleY: number;
    initialBounds: Box;
    initialShape: T;
}, opts?: ResizeBoxOptions): T;
//# sourceMappingURL=resizeBox.d.ts.map