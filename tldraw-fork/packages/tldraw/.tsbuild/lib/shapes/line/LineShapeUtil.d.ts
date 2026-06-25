import { HandleSnapGeometry, ShapeUtil, SvgExportContext, TLHandle, TLHandleDragInfo, TLLineShape, TLLineShapePoint, TLResizeInfo } from '@tldraw/editor';
import { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
import { PathBuilderGeometry2d } from '../shared/PathBuilder';
/** @public */
export interface LineShapeUtilDisplayValues {
    strokeColor: string;
    strokeWidth: number;
}
/** @public */
export interface LineShapeOptions extends ShapeOptionsWithDisplayValues<TLLineShape, LineShapeUtilDisplayValues> {
}
/** @public */
export declare class LineShapeUtil extends ShapeUtil<TLLineShape> {
    static type: "line";
    static props: import("@tldraw/tlschema").RecordProps<TLLineShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: LineShapeOptions;
    hideResizeHandles(shape: TLLineShape): boolean;
    hideRotateHandle(shape: TLLineShape): boolean;
    hideSelectionBoundsFg(shape: TLLineShape): boolean;
    hideSelectionBoundsBg(shape: TLLineShape): boolean;
    hideInMinimap(): boolean;
    getDefaultProps(): TLLineShape['props'];
    getGeometry(shape: TLLineShape): PathBuilderGeometry2d;
    getHandles(shape: TLLineShape): TLHandle[];
    onResize(shape: TLLineShape, info: TLResizeInfo<TLLineShape>): {
        props: {
            points: {
                [x: string]: {
                    id: string;
                    index: import("@tldraw/utils").IndexKey;
                    x: number;
                    y: number;
                };
            };
        };
    };
    onBeforeCreate(next: TLLineShape): void | TLLineShape;
    onHandleDrag(shape: TLLineShape, { handle }: TLHandleDragInfo<TLLineShape>): {
        id: import("@tldraw/tlschema").TLShapeId;
        typeName: "shape";
        type: "line";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            dash: "dashed" | "dotted" | "draw" | "none" | "solid";
            size: "l" | "m" | "s" | "xl";
            spline: "cubic" | "line";
            scale: number;
            points: {
                [x: string]: TLLineShapePoint | {
                    id: string;
                    index: import("@tldraw/utils").IndexKey;
                    x: number;
                    y: number;
                };
            };
        };
    };
    onHandleDragStart(shape: TLLineShape, { handle }: TLHandleDragInfo<TLLineShape>): {
        id: import("@tldraw/tlschema").TLShapeId;
        typeName: "shape";
        type: "line";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            dash: "dashed" | "dotted" | "draw" | "none" | "solid";
            size: "l" | "m" | "s" | "xl";
            spline: "cubic" | "line";
            scale: number;
            points: {
                [x: string]: TLLineShapePoint | {
                    id: import("@tldraw/utils").IndexKey;
                    index: import("@tldraw/utils").IndexKey;
                    x: number;
                    y: number;
                };
            };
        };
    } | undefined;
    component(shape: TLLineShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLLineShape): Path2D;
    toSvg(shape: TLLineShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    getHandleSnapGeometry(shape: TLLineShape): HandleSnapGeometry;
    getInterpolatedProps(startShape: TLLineShape, endShape: TLLineShape, t: number): TLLineShape['props'];
}
//# sourceMappingURL=LineShapeUtil.d.ts.map