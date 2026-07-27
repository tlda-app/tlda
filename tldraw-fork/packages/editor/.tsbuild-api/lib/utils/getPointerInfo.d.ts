import type React from 'react';
import { Editor } from '../editor/Editor';
import { TLViewportId } from '../editor/viewports/TLViewport';
/** @public */
export declare function getPointerInfo(editor: Editor, e: PointerEvent | React.PointerEvent, opts?: {
    viewportId?: TLViewportId;
}): {
    accelKey: boolean;
    altKey: boolean;
    button: number;
    ctrlKey: boolean;
    isPen: boolean;
    metaKey: boolean;
    point: {
        x: number;
        y: number;
        z: number;
    };
    pointerId: number;
    shiftKey: boolean;
    viewportId: string | undefined;
};
//# sourceMappingURL=getPointerInfo.d.ts.map