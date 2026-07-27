import { StateNode, TLClickEventInfo, TLKeyboardEventInfo, TLPointerEventInfo, TLShape } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    selectedShapesOnKeyDown: TLShape[];
    onEnter(): void;
    onExit(): void;
    onPointerMove(): void;
    onPointerDown(info: TLPointerEventInfo): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onRightClick(info: TLPointerEventInfo): void;
    onCancel(): void;
    onKeyDown(info: TLKeyboardEventInfo): void;
    onKeyRepeat(info: TLKeyboardEventInfo): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    private startEditingShape;
    isOverArrowLabelTest(shape: TLShape | undefined): boolean;
    handleDoubleClickOnCanvas(info: TLClickEventInfo): void;
    private nudgeSelectedShapes;
}
export declare const MAJOR_NUDGE_FACTOR = 10;
export declare const MINOR_NUDGE_FACTOR = 1;
export declare const GRID_INCREMENT = 5;
//# sourceMappingURL=Idle.d.ts.map