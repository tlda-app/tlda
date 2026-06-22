import { StateNode, TLPointerEventInfo, type TLKeyboardEventInfo } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    onEnter(info?: TLPointerEventInfo): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    onPointerDown(info: TLPointerEventInfo): void;
    onCancel(): void;
}
//# sourceMappingURL=Idle.d.ts.map