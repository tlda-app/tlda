import { StateNode, TLPointerEventInfo } from '@tldraw/editor';
export declare class OneFingerZooming extends StateNode {
    static id: string;
    private anchorScreenPoint;
    private initialCamera;
    private initialZoom;
    private originScreenY;
    onEnter(_info: TLPointerEventInfo): void;
    onPointerMove(_info: TLPointerEventInfo): void;
    onPointerUp(_info: TLPointerEventInfo): void;
    onCancel(): void;
    onInterrupt(): void;
    private complete;
    private clampZoom;
}
//# sourceMappingURL=OneFingerZooming.d.ts.map