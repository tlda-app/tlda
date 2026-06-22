import { StateNode, TLClickEventInfo, TLPointerEventInfo } from '@tldraw/editor';
export declare class PointingSelection extends StateNode {
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
        target: "selection";
        handle?: import("@tldraw/editor").TLSelectionHandle | undefined;
        shape?: undefined;
    } & {
        target: "selection";
    };
    onEnter(info: TLPointerEventInfo & {
        target: 'selection';
    }): void;
    onPointerUp(info: TLPointerEventInfo): void;
    onPointerMove(info: TLPointerEventInfo): void;
    onLongPress(info: TLPointerEventInfo): void;
    private startTranslating;
    onDoubleClick(info: TLClickEventInfo): void;
    onCancel(): void;
    onComplete(): void;
    onInterrupt(): void;
    private cancel;
}
//# sourceMappingURL=PointingSelection.d.ts.map