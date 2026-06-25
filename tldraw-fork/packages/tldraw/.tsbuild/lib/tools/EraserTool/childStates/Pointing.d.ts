import { StateNode, TLPointerEventInfo } from '@tldraw/editor';
export declare class Pointing extends StateNode {
    static id: string;
    onEnter(info: TLPointerEventInfo): void;
    onLongPress(info: TLPointerEventInfo): void;
    onExit(_info: any, to: string): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private startErasing;
    complete(info?: TLPointerEventInfo): void;
    cancel(): void;
}
//# sourceMappingURL=Pointing.d.ts.map