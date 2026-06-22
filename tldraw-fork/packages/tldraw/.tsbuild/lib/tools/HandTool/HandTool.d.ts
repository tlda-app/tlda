import { StateNode, TLClickEventInfo, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class HandTool extends StateNode {
    static id: string;
    static initial: string;
    static isLockable: boolean;
    static children(): TLStateNodeConstructor[];
    onDoubleClick(info: TLClickEventInfo): void;
}
//# sourceMappingURL=HandTool.d.ts.map