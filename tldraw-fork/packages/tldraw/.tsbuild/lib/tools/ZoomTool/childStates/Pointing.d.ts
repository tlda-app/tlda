import { StateNode, TLPointerEventInfo } from '@tldraw/editor';
export declare class Pointing extends StateNode {
    static id: string;
    info: TLPointerEventInfo & {
        onInteractionEnd?: string | undefined;
    };
    onEnter(info: TLPointerEventInfo & {
        onInteractionEnd: string;
    }): void;
    onPointerUp(): void;
    onPointerMove(): void;
    onCancel(): void;
    private complete;
    private cancel;
}
//# sourceMappingURL=Pointing.d.ts.map