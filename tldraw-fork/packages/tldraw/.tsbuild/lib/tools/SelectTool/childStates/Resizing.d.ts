import { SelectionCorner, SelectionEdge, StateNode, TLPointerEventInfo, TLShape, TLTickEventInfo, VecLike } from '@tldraw/editor';
export type ResizingInfo = TLPointerEventInfo & {
    target: 'selection';
    handle: SelectionEdge | SelectionCorner;
    isCreating?: boolean;
    creatingMarkId?: string;
    onCreate?(shape: TLShape | null): void;
    creationCursorOffset?: VecLike;
    onInteractionEnd?: string | (() => void);
};
export declare class Resizing extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    info: import("@tldraw/editor").TLBaseEventInfo & {
        type: "pointer";
        name: import("@tldraw/editor").TLPointerEventName;
        point: VecLike;
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
        handle: SelectionCorner | SelectionEdge;
        isCreating?: boolean | undefined;
        creatingMarkId?: string | undefined;
        onCreate?(shape: TLShape | null): void;
        creationCursorOffset?: VecLike | undefined;
        onInteractionEnd?: string | (() => void) | undefined;
    };
    markId: string;
    private didHoldCommand;
    creationCursorOffset: VecLike;
    private snapshot;
    onEnter(info: ResizingInfo): void;
    onTick({ elapsed }: TLTickEventInfo): void;
    onPointerMove(): void;
    onKeyDown(): void;
    onKeyUp(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(): void;
    private cancel;
    private complete;
    private handleResizeStart;
    private handleResizeEnd;
    private updateShapes;
    private updateEnclosureHints;
    private updateCursor;
    onExit(): void;
    private _createSnapshot;
}
export declare function rotateSelectionHandle(handle: SelectionEdge | SelectionCorner, rotation: number): SelectionCorner | SelectionEdge;
//# sourceMappingURL=Resizing.d.ts.map