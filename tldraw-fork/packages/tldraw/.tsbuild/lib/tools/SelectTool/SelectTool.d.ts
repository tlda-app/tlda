import { StateNode, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class SelectTool extends StateNode {
    static id: string;
    static initial: string;
    static isLockable: boolean;
    reactor: undefined | (() => void);
    static children(): TLStateNodeConstructor[];
    cleanUpDuplicateProps(): void;
    onEnter(): void;
    onExit(): void;
}
//# sourceMappingURL=SelectTool.d.ts.map