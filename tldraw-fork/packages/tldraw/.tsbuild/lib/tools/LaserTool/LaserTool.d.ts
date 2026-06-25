import { StateNode, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class LaserTool extends StateNode {
    static id: string;
    static initial: string;
    static children(): TLStateNodeConstructor[];
    static isLockable: boolean;
    private sessionId;
    onEnter(): void;
    onExit(): void;
    onCancel(): void;
    /**
     * Get the current laser session ID, or create a new one if none exists or the current one is fading.
     */
    getSessionId(): string;
}
//# sourceMappingURL=LaserTool.d.ts.map