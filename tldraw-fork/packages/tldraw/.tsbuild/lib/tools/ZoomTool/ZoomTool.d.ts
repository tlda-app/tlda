import { StateNode, TLKeyboardEventInfo, TLPointerEventInfo, TLStateNodeConstructor } from '@tldraw/editor';
/** @public */
export declare class ZoomTool extends StateNode {
    static id: string;
    static initial: string;
    static children(): TLStateNodeConstructor[];
    static isLockable: boolean;
    info: TLPointerEventInfo & {
        onInteractionEnd?: string | undefined;
    };
    onEnter(info: TLPointerEventInfo & {
        onInteractionEnd: string;
    }): void;
    onExit(): void;
    onKeyDown(): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    onInterrupt(): void;
    private complete;
    private updateCursor;
}
//# sourceMappingURL=ZoomTool.d.ts.map