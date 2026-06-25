import { StateNode } from '@tldraw/editor';
export declare class Lasering extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    private scribbleId;
    private sessionId;
    onEnter(info: {
        sessionId: string;
        scribbleId: string;
    }): void;
    onPointerMove(): void;
    private pushPointToScribble;
    onTick(): void;
    onPointerUp(): void;
    onCancel(): void;
    onComplete(): void;
    private complete;
}
//# sourceMappingURL=Lasering.d.ts.map