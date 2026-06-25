import { StateNode, TLCancelEventInfo, TLKeyboardEventInfo, TLPointerEventInfo, TLShapeId, TLTickEventInfo } from '@tldraw/editor';
export declare class Brushing extends StateNode {
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
        target: "canvas";
        shape?: undefined;
    } & {
        target: "canvas";
    };
    initialSelectedShapeIds: TLShapeId[];
    excludedShapeIds: Set<TLShapeId>;
    isWrapMode: boolean;
    viewportDidChange: boolean;
    cleanupViewportChangeReactor(): void;
    onEnter(info: TLPointerEventInfo & {
        target: 'canvas';
    }): void;
    onExit(): void;
    onTick({ elapsed }: TLTickEventInfo): void;
    onPointerMove(): void;
    onPointerUp(): void;
    onComplete(): void;
    onCancel(info: TLCancelEventInfo): void;
    onKeyDown(info: TLKeyboardEventInfo): void;
    onKeyUp(): void;
    private complete;
    private hitTestShapes;
    onInterrupt(): void;
    private handleHit;
}
//# sourceMappingURL=Brushing.d.ts.map