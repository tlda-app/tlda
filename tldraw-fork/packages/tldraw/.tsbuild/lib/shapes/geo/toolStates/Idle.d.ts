import { StateNode, TLKeyboardEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    onPointerDown(info: TLPointerEventInfo): void;
    onEnter(): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    onCancel(): void;
}
//# sourceMappingURL=Idle.d.ts.map