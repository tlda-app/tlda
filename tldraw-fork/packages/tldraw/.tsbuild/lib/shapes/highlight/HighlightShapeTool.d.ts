import { StateNode, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class HighlightShapeTool extends StateNode {
    static id: string;
    static initial: string;
    static useCoalescedEvents: boolean;
    static children(): TLStateNodeConstructor[];
    static isLockable: boolean;
    shapeType: string;
    onExit(): void;
}
//# sourceMappingURL=HighlightShapeTool.d.ts.map