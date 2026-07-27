import { StateNode } from '@tldraw/editor';
export declare class Pointing extends StateNode {
    static id: string;
    onEnter(): void;
    onLongPress(): void;
    onPointerMove(): void;
    private startDragging;
    onPointerUp(): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private complete;
}
//# sourceMappingURL=Pointing.d.ts.map