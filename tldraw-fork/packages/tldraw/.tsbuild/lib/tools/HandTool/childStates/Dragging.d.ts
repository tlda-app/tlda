import { StateNode, Vec } from '@tldraw/editor';
export declare class Dragging extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    initialCamera: Vec;
    onEnter(): void;
    onPointerMove(): void;
    onPointerDown(): void;
    onPointerUp(): void;
    onInterrupt(): void;
    onCancel(): void;
    onComplete(): void;
    private update;
    private complete;
}
//# sourceMappingURL=Dragging.d.ts.map