import { Editor, Group2d, ShapeUtil, SvgExportContext, TLArrowShape, TLArrowShapeProps, TLHandle, TLHandleDragInfo, TLResizeInfo, TLShapePartial, TLShapeUtilCanBeLaidOutOpts, TLShapeUtilCanBindOpts, TLShapeUtilCanvasSvgDef } from '@tldraw/editor';
import { ArrowShapeOptions } from './arrow-types';
/** @public */
export declare class ArrowShapeUtil extends ShapeUtil<TLArrowShape> {
    static type: "arrow";
    static props: import("@tldraw/tlschema").RecordProps<TLArrowShape>;
    static migrations: import("@tldraw/store").MigrationSequence;
    options: ArrowShapeOptions;
    canEdit(shape: TLArrowShape): boolean;
    canBind({ toShape }: TLShapeUtilCanBindOpts<TLArrowShape>): boolean;
    canSnap(shape: TLArrowShape): boolean;
    hideResizeHandles(shape: TLArrowShape): boolean;
    hideRotateHandle(shape: TLArrowShape): boolean;
    hideSelectionBoundsBg(shape: TLArrowShape): boolean;
    hideSelectionBoundsFg(shape: TLArrowShape): boolean;
    hideInMinimap(): boolean;
    canBeLaidOut(shape: TLArrowShape, info: TLShapeUtilCanBeLaidOutOpts): boolean;
    getFontFaces(shape: TLArrowShape): import("@tldraw/tlschema").TLFontFace[];
    getDefaultProps(): TLArrowShape['props'];
    getGeometry(shape: TLArrowShape): Group2d;
    getHandles(shape: TLArrowShape): TLHandle[];
    getText(shape: TLArrowShape): string;
    onHandleDrag(shape: TLArrowShape, info: TLHandleDragInfo<TLArrowShape>): {
        id: import("@tldraw/tlschema").TLShapeId;
        type: "arrow";
        props: {
            bend: number;
        };
    } | {
        id: import("@tldraw/tlschema").TLShapeId;
        type: "arrow";
        props: {
            elbowMidPoint: number;
        };
    } | ({
        id: import("@tldraw/tlschema").TLShapeId;
        type: "arrow";
        props?: Partial<TLArrowShapeProps> | undefined;
        meta?: Partial<import("@tldraw/utils").JsonObject> | undefined;
    } & Partial<Omit<TLArrowShape, "id" | "meta" | "props" | "type">>) | undefined;
    private onArcMidpointHandleDrag;
    private onElbowMidpointHandleDrag;
    private onTerminalHandleDrag;
    onTranslateStart(shape: TLArrowShape): ({
        id: import("@tldraw/tlschema").TLShapeId;
        type: "arrow";
        props?: Partial<TLArrowShapeProps> | undefined;
        meta?: Partial<import("@tldraw/utils").JsonObject> | undefined;
    } & Partial<Omit<TLArrowShape, "id" | "meta" | "props" | "type">>) | undefined;
    onTranslate(initialShape: TLArrowShape, shape: TLArrowShape): void;
    private readonly _resizeInitialBindings;
    onResize(shape: TLArrowShape, info: TLResizeInfo<TLArrowShape>): {
        props: {
            start: import("@tldraw/tlschema").VecModel;
            end: import("@tldraw/tlschema").VecModel;
            bend: number;
        };
    };
    onDoubleClickHandle(shape: TLArrowShape, handle: TLHandle): TLShapePartial<TLArrowShape> | void;
    component(shape: TLArrowShape): import("react/jsx-runtime").JSX.Element | null;
    getIndicatorPath(shape: TLArrowShape): Path2D | {
        path: Path2D;
        clipPath: Path2D;
        additionalPaths: Path2D[];
    } | undefined;
    onEditStart(shape: TLArrowShape): void;
    toSvg(shape: TLArrowShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    getCanvasSvgDefs(): TLShapeUtilCanvasSvgDef[];
    getInterpolatedProps(startShape: TLArrowShape, endShape: TLArrowShape, progress: number): TLArrowShapeProps;
}
export declare function getArrowLength(editor: Editor, shape: TLArrowShape): number;
//# sourceMappingURL=ArrowShapeUtil.d.ts.map