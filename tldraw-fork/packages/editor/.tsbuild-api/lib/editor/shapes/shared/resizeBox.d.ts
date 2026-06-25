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
    handle: TLResizeHandle;
    initialBounds: Box;
    initialShape: T;
    mode: TLResizeMode;
    newPoint: VecModel;
    scaleX: number;
    scaleY: number;
}, opts?: ResizeBoxOptions): T;
//# sourceMappingURL=resizeBox.d.ts.map