import { StateNode, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class DrawShapeTool extends StateNode {
    static id: string;
    static initial: string;
    static isLockable: boolean;
    static useCoalescedEvents: boolean;
    static children(): TLStateNodeConstructor[];
    shapeType: string;
    onExit(): void;
}
//# sourceMappingURL=DrawShapeTool.d.ts.map