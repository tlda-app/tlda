import { StateNode, TLKeyboardEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    onPointerMove(info: TLPointerEventInfo): void;
    onPointerDown(info: TLPointerEventInfo): void;
    onEnter(): void;
    onExit(): void;
    onKeyDown(info: TLKeyboardEventInfo): void;
    onCancel(): void;
}
//# sourceMappingURL=Idle.d.ts.map