import type React from 'react';
import { Editor } from '../editor/Editor';
import { TLViewportId } from '../editor/viewports/TLViewport';
/** @public */
export declare function getPointerInfo(editor: Editor, e: React.PointerEvent | PointerEvent, opts?: {
    viewportId?: TLViewportId;
}): {
    viewportId: string | undefined;
    point: {
        x: number;
        y: number;
        z: number;
    };
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    accelKey: boolean;
    pointerId: number;
    button: number;
    isPen: boolean;
};
//# sourceMappingURL=getPointerInfo.d.ts.map