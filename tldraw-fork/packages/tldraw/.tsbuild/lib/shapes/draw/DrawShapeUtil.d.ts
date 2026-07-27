import { Circle2d, Polyline2d, ShapeUtil, SvgExportContext, TLDrawShape, TLDrawShapeProps, TLResizeInfo, TLShapeUtilCanvasSvgDef } from '@tldraw/editor';
import { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface DrawShapeUtilDisplayValues {
    strokeColor: string;
    strokeWidth: number;
    fillColor: string;
    patternFillFallbackColor: string;
}
/** @public */
export interface DrawShapeOptions extends ShapeOptionsWithDisplayValues<TLDrawShape, DrawShapeUtilDisplayValues> {
    /**
     * The maximum number of points in a line before the draw tool will begin a new shape.
     * A higher number will lead to poor performance while drawing very long lines.
     */
    readonly maxPointsPerShape: number;
}
/** @public */
export declare class DrawShapeUtil extends ShapeUtil<TLDrawShape> {
    static type: "draw";
    static props: import("@tldraw/tlschema").RecordProps<TLDrawShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: DrawShapeOptions;
    hideResizeHandles(shape: TLDrawShape): boolean;
    hideRotateHandle(shape: TLDrawShape): boolean;
    hideSelectionBoundsFg(shape: TLDrawShape): boolean;
    getDefaultProps(): TLDrawShape['props'];
    getGeometry(shape: TLDrawShape): Circle2d | Polyline2d;
    component(shape: TLDrawShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLDrawShape): Path2D;
    toSvg(shape: TLDrawShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    getCanvasSvgDefs(): TLShapeUtilCanvasSvgDef[];
    onResize(shape: TLDrawShape, info: TLResizeInfo<TLDrawShape>): {
        props: {
            scaleX: number;
            scaleY: number;
        };
    } | undefined;
    expandSelectionOutlinePx(shape: TLDrawShape): number;
    getInterpolatedProps(startShape: TLDrawShape, endShape: TLDrawShape, t: number): TLDrawShapeProps;
}
//# sourceMappingURL=DrawShapeUtil.d.ts.map