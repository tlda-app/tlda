import { StateNode, TLCancelEventInfo, TLCompleteEventInfo, TLPointerEventInfo, TLShape } from '@tldraw/editor';
interface EditingShapeInfo {
    isCreatingTextWhileToolLocked?: boolean;
}
export declare class EditingShape extends StateNode {
    static id: string;
    hitLabelOnShapeForPointerUp: TLShape | null;
    private info;
    private didPointerDownOnEditingShape;
    private isTextInputFocused;
    onEnter(info: EditingShapeInfo): void;
    onExit(): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onPointerDown(info: TLPointerEventInfo): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onComplete(info: TLCompleteEventInfo): void;
    onCancel(info: TLCancelEventInfo): void;
}
export {};
//# sourceMappingURL=EditingShape.d.ts.map