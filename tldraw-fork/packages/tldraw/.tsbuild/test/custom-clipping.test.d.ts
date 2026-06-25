import { BaseBoxShapeUtil, Geometry2d, RecordProps, StateNode, TLEventHandlers, TLResizeInfo, TLShape, Vec } from '@tldraw/editor';
declare const CIRCLE_CLIP_TYPE = "circle-clip";
declare module '@tldraw/tlschema' {
    interface TLGlobalShapePropsMap {
        [CIRCLE_CLIP_TYPE]: {
            w: number;
            h: number;
        };
    }
}
export type CircleClipShape = TLShape<typeof CIRCLE_CLIP_TYPE>;
export declare const isClippingEnabled$: import("@tldraw/state").Atom<boolean, unknown>;
export declare class CircleClipShapeUtil extends BaseBoxShapeUtil<CircleClipShape> {
    static type: string;
    static props: RecordProps<CircleClipShape>;
    canBind(): boolean;
    canReceiveNewChildrenOfType(shape: TLShape): boolean;
    getDefaultProps(): CircleClipShape['props'];
    getGeometry(shape: CircleClipShape): Geometry2d;
    getClipPath(shape: CircleClipShape): Vec[] | undefined;
    shouldClipChild(_child: TLShape): boolean;
    component(shape: CircleClipShape): any;
    getIndicatorPath(): undefined;
    onResize(shape: CircleClipShape, info: TLResizeInfo<CircleClipShape>): import("@tldraw/tlschema").TLBaseShape<"circle-clip", {
        w: number;
        h: number;
    }>;
}
export declare class CircleClipShapeTool extends StateNode {
    static id: string;
    onEnter(): void;
    onPointerDown(info: Parameters<TLEventHandlers['onPointerDown']>[0]): void;
}
export {};
//# sourceMappingURL=custom-clipping.test.d.ts.map