import React from 'react';
import { TLViewportId } from '../editor/viewports/TLViewport';
export declare function useCanvasEvents(opts?: {
    viewportId?: TLViewportId;
}): {
    onPointerDown: (e: React.PointerEvent<Element>) => void;
    onPointerUp: (e: React.PointerEvent<Element>) => void;
    onPointerCancel: (e: React.PointerEvent<Element>) => void;
    onPointerEnter: (e: React.PointerEvent<Element>) => void;
    onPointerLeave: (e: React.PointerEvent<Element>) => void;
    onDragOver: (e: React.DragEvent<Element>) => void;
    onDrop: (e: React.DragEvent<Element>) => Promise<void>;
    onTouchStart: (e: React.TouchEvent<Element>) => void;
    onTouchEnd: (e: React.TouchEvent<Element>) => void;
    onClick: (e: React.MouseEvent<Element, MouseEvent>) => void;
    onContextMenu: (e: React.MouseEvent<Element, MouseEvent>) => void;
};
//# sourceMappingURL=useCanvasEvents.d.ts.map