import { StateNode, TLClickEventInfo, TLKeyboardEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    onEnter(): void;
    onExit(): void;
    onPointerMove(): void;
    onCancel(): void;
    onPointerDown(info: TLPointerEventInfo): void;
    onDoubleClick(info: TLClickEventInfo): void;
    onKeyDown(): void;
    onKeyRepeat(): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    private cancel;
    private nudgeCroppingImage;
}
//# sourceMappingURL=Idle.d.ts.map