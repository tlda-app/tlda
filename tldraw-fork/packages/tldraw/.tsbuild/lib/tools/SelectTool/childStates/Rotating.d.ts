import { StateNode, TLPointerEventInfo, TLRotationSnapshot } from '@tldraw/editor';
export declare class Rotating extends StateNode {
    static id: string;
    static trackPerformance: boolean;
    snapshot: TLRotationSnapshot;
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
        onInteractionEnd?: string | (() => void) | undefined;
    };
    markId: string;
    onEnter(info: TLPointerEventInfo & {
        target: 'selection';
        onInteractionEnd?: string | (() => void);
    }): void;
    onExit(): void;
    onPointerMove(): void;
    onKeyDown(): void;
    onKeyUp(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(): void;
    private update;
    private cancel;
    private complete;
    _getRotationFromPointerPosition({ snapToNearestDegree }: {
        snapToNearestDegree: boolean;
    }): number;
}
//# sourceMappingURL=Rotating.d.ts.map