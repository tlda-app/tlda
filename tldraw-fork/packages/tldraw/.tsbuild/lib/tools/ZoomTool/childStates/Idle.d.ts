import { StateNode, TLKeyboardEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    info: TLPointerEventInfo & {
        onInteractionEnd?: string | undefined;
    };
    onEnter(info: TLPointerEventInfo & {
        onInteractionEnd: string;
    }): void;
    onPointerDown(): void;
    onKeyDown(info: TLKeyboardEventInfo): void;
}
//# sourceMappingURL=Idle.d.ts.map