import { StateNode, TLKeyboardEventInfo, TLPointerEventInfo, TLShapeId } from '@tldraw/editor';
export declare class Idle extends StateNode {
    static id: string;
    isPrecise: boolean;
    isPreciseTimerId: number | null;
    preciseTargetId: TLShapeId | null;
    onPointerMove(): void;
    onPointerDown(info: TLPointerEventInfo): void;
    onEnter(): void;
    onCancel(): void;
    onExit(): void;
    onKeyDown(): void;
    onKeyUp(info: TLKeyboardEventInfo): void;
    update(): void;
}
//# sourceMappingURL=Idle.d.ts.map