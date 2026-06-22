import { SelectionHandle, StateNode, TLPointerEventInfo } from '@tldraw/editor';
export declare class Cropping extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    info: import("@tldraw/editor").TLBaseEventInfo & {
        type: "pointer";
        name: import("@tldraw/editor").TLPointerEventName;
        point: import("@tldraw/editor").VecLike;
        pointerId: number;
        button: number;
        isPen: boolean;
        isPenDirect?: boolean | undefined;
    } & {
        target: "selection";
        handle?: import("@tldraw/editor").TLSelectionHandle | undefined;
        shape?: undefined;
    } & {
        target: "selection";
        handle: SelectionHandle;
        onInteractionEnd?: string | (() => void) | undefined;
    };
    markId: string;
    private snapshot;
    onEnter(info: TLPointerEventInfo & {
        target: 'selection';
        handle: SelectionHandle;
        onInteractionEnd?: string | (() => void);
    }): void;
    onPointerMove(): void;
    onKeyDown(): void;
    onKeyUp(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(): void;
    onExit(): void;
    private updateCursor;
    private updateShapes;
    private complete;
    private cancel;
    private createSnapshot;
}
//# sourceMappingURL=Cropping.d.ts.map