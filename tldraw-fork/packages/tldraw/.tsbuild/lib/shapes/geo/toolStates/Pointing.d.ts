import { StateNode, TLPointerEventInfo } from '@tldraw/editor';
export declare class Pointing extends StateNode {
    static id: string;
    onPointerUp(): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    onLongPress(): void;
    private complete;
    private cancel;
}
//# sourceMappingURL=Pointing.d.ts.map