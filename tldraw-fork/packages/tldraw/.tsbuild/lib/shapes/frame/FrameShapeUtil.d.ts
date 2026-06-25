import { BaseFrameLikeShapeUtil, Geometry2d, SvgExportContext, TLClickEventInfo, TLEditStartInfo, TLFrameShape, TLFrameShapeProps, TLShapeUtilConstructor } from '@tldraw/editor';
import { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface FrameShapeUtilDisplayValues {
    fillColor: string;
    strokeColor: string;
    showColorsFillColor: string;
    showColorsStrokeColor: string;
    headingFillColor: string;
    headingStrokeColor: string;
    headingTextColor: string;
    showColorsHeadingFillColor: string;
    showColorsHeadingStrokeColor: string;
    showColorsHeadingTextColor: string;
}
/** @public */
export interface FrameShapeOptions extends ShapeOptionsWithDisplayValues<TLFrameShape, FrameShapeUtilDisplayValues> {
    /**
     * When true, the frame will display colors for the shape's headings and background.
     */
    showColors: boolean;
    /**
     * When true, the frame will resize its children when the frame itself is resized.
     */
    resizeChildren: boolean;
}
/** @public */
export declare class FrameShapeUtil extends BaseFrameLikeShapeUtil<TLFrameShape> {
    static type: "frame";
    static props: import("@tldraw/tlschema").RecordProps<TLFrameShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: FrameShapeOptions;
    static configure<T extends TLShapeUtilConstructor<any, any>>(this: T, options: T extends new (...args: any[]) => {
        options: infer Options;
    } ? Partial<Options> : never): T;
    canEdit(shape: TLFrameShape, info: TLEditStartInfo): boolean;
    canResize(shape: TLFrameShape): boolean;
    canResizeChildren(shape: TLFrameShape): boolean;
    isExportBoundsContainer(): boolean;
    getDefaultProps(): TLFrameShape['props'];
    getAriaDescriptor(shape: TLFrameShape): string;
    getGeometry(shape: TLFrameShape): Geometry2d;
    getText(shape: TLFrameShape): string | undefined;
    component(shape: TLFrameShape): import("react/jsx-runtime").JSX.Element;
    toSvg(shape: TLFrameShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLFrameShape): Path2D;
    getInterpolatedProps(startShape: TLFrameShape, endShape: TLFrameShape, t: number): TLFrameShapeProps;
    onDoubleClickEdge(shape: TLFrameShape, info: TLClickEventInfo): {
        id: import("@tldraw/tlschema").TLShapeId;
        type: "frame";
        props: {
            w: number;
            h: number;
        };
    } | undefined;
    onDoubleClickCorner(shape: TLFrameShape): {
        id: import("@tldraw/tlschema").TLShapeId;
        type: "frame";
    };
}
//# sourceMappingURL=FrameShapeUtil.d.ts.map