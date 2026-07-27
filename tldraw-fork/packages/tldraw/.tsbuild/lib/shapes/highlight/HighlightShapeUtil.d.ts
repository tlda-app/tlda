import { Circle2d, Polygon2d, ShapeUtil, SvgExportContext, TLHighlightShape, TLHighlightShapeProps, TLResizeInfo } from '@tldraw/editor';
import type { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface HighlightShapeUtilDisplayValues {
    strokeColor: string;
    strokeWidth: number;
    underlayOpacity: number;
    overlayOpacity: number;
}
/** @public */
export interface HighlightShapeOptions extends ShapeOptionsWithDisplayValues<TLHighlightShape, HighlightShapeUtilDisplayValues> {
    /**
     * The maximum number of points in a line before the draw tool will begin a new shape.
     * A higher number will lead to poor performance while drawing very long lines.
     */
    readonly maxPointsPerShape: number;
}
/** @public */
export declare class HighlightShapeUtil extends ShapeUtil<TLHighlightShape> {
    static type: "highlight";
    static props: import("@tldraw/tlschema").RecordProps<TLHighlightShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: HighlightShapeOptions;
    hideResizeHandles(shape: TLHighlightShape): boolean;
    hideRotateHandle(shape: TLHighlightShape): boolean;
    hideSelectionBoundsFg(shape: TLHighlightShape): boolean;
    getDefaultProps(): TLHighlightShape['props'];
    getGeometry(shape: TLHighlightShape): Circle2d | Polygon2d;
    component(shape: TLHighlightShape): import("react/jsx-runtime").JSX.Element;
    backgroundComponent(shape: TLHighlightShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLHighlightShape): Path2D;
    toSvg(shape: TLHighlightShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    toBackgroundSvg(shape: TLHighlightShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    onResize(shape: TLHighlightShape, info: TLResizeInfo<TLHighlightShape>): {
        props: {
            scaleX: number;
            scaleY: number;
        };
    } | undefined;
    getInterpolatedProps(startShape: TLHighlightShape, endShape: TLHighlightShape, t: number): TLHighlightShapeProps;
}
//# sourceMappingURL=HighlightShapeUtil.d.ts.map