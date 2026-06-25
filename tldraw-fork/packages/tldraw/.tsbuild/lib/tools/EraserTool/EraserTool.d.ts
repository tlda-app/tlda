import { StateNode, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class EraserTool extends StateNode {
    static id: string;
    static initial: string;
    static isLockable: boolean;
    static children(): TLStateNodeConstructor[];
    info: {
        onInteractionEnd?: string | undefined;
    };
    onEnter(info?: {
        onInteractionEnd?: string;
    }): void;
    onExit(): void;
    maybeReturnToOriginatingTool(): void;
}
//# sourceMappingURL=EraserTool.d.ts.map