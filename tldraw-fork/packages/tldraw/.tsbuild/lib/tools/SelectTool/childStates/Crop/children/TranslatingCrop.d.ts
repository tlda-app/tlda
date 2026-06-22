import { StateNode, TLKeyboardEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class TranslatingCrop extends StateNode {
    static id: string;
    info: import("@tldraw/editor").TLBaseEventInfo & {
        type: "pointer";
        name: import("@tldraw/editor").TLPointerEventName;
        point: import("@tldraw/editor").VecLike;
        pointerId: number;
        button: number;
        isPen: boolean;
        isPenDirect?: boolean | undefined;
    } & {
        target: "shape";
        shape: import("@tldraw/tlschema").TLShape;
    } & {
        target: "shape";
        isCreating?: boolean | undefined;
        onInteractionEnd?: string | undefined;
    };
    markId: string;
    private snapshot;
    onEnter(info: TLPointerEventInfo & {
        target: 'shape';
        isCreating?: boolean;
        onInteractionEnd?: string;
    }): void;
    onExit(): void;
    onPointerMove(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(): void;
    onKeyDown(info: TLKeyboardEventInfo): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    protected complete(): void;
    private cancel;
    private createSnapshot;
    protected updateShapes(): void;
}
//# sourceMappingURL=TranslatingCrop.d.ts.map