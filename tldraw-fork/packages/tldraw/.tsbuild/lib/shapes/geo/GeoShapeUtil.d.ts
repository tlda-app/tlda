import { BaseBoxShapeUtil, Editor, Group2d, HandleSnapGeometry, SvgExportContext, TLGeoShape, TLGeoShapeProps, TLResizeInfo, TLShape, TLShapeId, TLShapeUtilCanvasSvgDef, TLShapeUtilConstructor, VecLike } from '@tldraw/editor';
import { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
import { type GeoTypeDefinition } from './getGeoShapePath';
/** @public */
export interface GeoShapeUtilDisplayValues {
    strokeColor: string;
    strokeRoundness: number;
    strokeWidth: number;
    fillColor: string;
    patternFillFallbackColor: string;
    labelColor: string;
    labelFontFamily: string;
    labelFontSize: number;
    labelMinWidth: number;
    labelExtraPadding: number;
    labelLineHeight: number;
    labelFontWeight: string;
    labelFontVariant: string;
    labelFontStyle: string;
    labelHorizontalAlign: 'start' | 'center' | 'end';
    labelVerticalAlign: 'start' | 'middle' | 'end';
    labelPadding: number;
    labelEdgeMargin: number;
    minSizeWithLabel: number;
}
/** @public */
export interface GeoShapeOptions extends ShapeOptionsWithDisplayValues<TLGeoShape, GeoShapeUtilDisplayValues> {
    showTextOutline: boolean;
    /**
     * A map of custom geo type definitions. Each key becomes a new value for
     * {@link @tldraw/editor#GeoShapeGeoStyle} that can be used in the style panel
     * and on shapes. Custom geo types inherit all standard geo shape behavior
     * (labels, resizing, styling, etc.).
     *
     * @example
     * ```ts
     * const MyGeoShapeUtil = GeoShapeUtil.configure({
     *   customGeoTypes: {
     *     'my-shape': {
     *       getPath: (w, h) => new PathBuilder().moveTo(0, 0).lineTo(w, 0).lineTo(w, h).lineTo(0, h).close(),
     *       snapType: 'polygon',
     *       icon: 'geo-rectangle',
     *     },
     *   },
     * })
     * ```
     */
    customGeoTypes?: Record<string, GeoTypeDefinition>;
}
/** @public */
export declare class GeoShapeUtil extends BaseBoxShapeUtil<TLGeoShape> {
    static type: "geo";
    static props: import("@tldraw/tlschema").RecordProps<TLGeoShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    static configure<T extends TLShapeUtilConstructor<any, any>>(this: T, options: T extends new (...args: any[]) => {
        options: infer Options;
    } ? Partial<Options> : never): T;
    options: GeoShapeOptions;
    canEdit(shape: TLGeoShape): boolean;
    getDefaultProps(): TLGeoShape['props'];
    getGeometry(shape: TLGeoShape): Group2d;
    getHandleSnapGeometry(shape: TLGeoShape): HandleSnapGeometry;
    getText(shape: TLGeoShape): string;
    getFontFaces(shape: TLGeoShape): import("@tldraw/tlschema").TLFontFace[];
    component(shape: TLGeoShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLGeoShape): Path2D | undefined;
    toSvg(shape: TLGeoShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    getCanvasSvgDefs(): TLShapeUtilCanvasSvgDef[];
    onResize(shape: TLGeoShape, { handle, newPoint, scaleX, scaleY, initialShape }: TLResizeInfo<TLGeoShape>): {
        x: number;
        y: number;
        props: {
            w: number;
            h: number;
            growY: number;
        };
    };
    onBeforeCreate(shape: TLGeoShape): {
        id: TLShapeId;
        typeName: "shape";
        type: "geo";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            geo: "arrow-down" | "arrow-left" | "arrow-right" | "arrow-up" | "check-box" | "cloud" | "diamond" | "ellipse" | "heart" | "hexagon" | "octagon" | "oval" | "pentagon" | "rectangle" | "rhombus" | "rhombus-2" | "star" | "trapezoid" | "triangle" | "x-box";
            dash: "dashed" | "dotted" | "draw" | "none" | "solid";
            url: string;
            w: number;
            h: number;
            scale: number;
            labelColor: import("@tldraw/tlschema").TLDefaultColorStyle;
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            fill: "fill" | "lined-fill" | "none" | "pattern" | "semi" | "solid";
            size: "l" | "m" | "s" | "xl";
            font: import("@tldraw/tlschema").TLDefaultFontStyle;
            align: "end" | "end-legacy" | "middle" | "middle-legacy" | "start" | "start-legacy";
            verticalAlign: "end" | "middle" | "start";
            richText: {
                attrs?: any;
                content: unknown[];
                type: string;
            };
            growY: number;
        };
    } | undefined;
    onBeforeUpdate(prev: TLGeoShape, next: TLGeoShape): {
        id: TLShapeId;
        typeName: "shape";
        type: "geo";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            geo: "arrow-down" | "arrow-left" | "arrow-right" | "arrow-up" | "check-box" | "cloud" | "diamond" | "ellipse" | "heart" | "hexagon" | "octagon" | "oval" | "pentagon" | "rectangle" | "rhombus" | "rhombus-2" | "star" | "trapezoid" | "triangle" | "x-box";
            dash: "dashed" | "dotted" | "draw" | "none" | "solid";
            url: string;
            w: number;
            h: number;
            scale: number;
            labelColor: import("@tldraw/tlschema").TLDefaultColorStyle;
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            fill: "fill" | "lined-fill" | "none" | "pattern" | "semi" | "solid";
            size: "l" | "m" | "s" | "xl";
            font: import("@tldraw/tlschema").TLDefaultFontStyle;
            align: "end" | "end-legacy" | "middle" | "middle-legacy" | "start" | "start-legacy";
            verticalAlign: "end" | "middle" | "start";
            richText: {
                attrs?: any;
                content: unknown[];
                type: string;
            };
            growY: number;
        };
    } | undefined;
    onDoubleClick(shape: TLGeoShape): {
        id: TLShapeId;
        typeName: "shape";
        type: "geo";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            geo: "check-box";
        };
    } | {
        id: TLShapeId;
        typeName: "shape";
        type: "geo";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            geo: "rectangle";
        };
    } | {
        id: TLShapeId;
        typeName: "shape";
        type: "geo";
        x: number;
        y: number;
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            geo: "arrow-down" | "arrow-left" | "arrow-right" | "arrow-up" | "check-box" | "cloud" | "diamond" | "ellipse" | "heart" | "hexagon" | "octagon" | "oval" | "pentagon" | "rectangle" | "rhombus" | "rhombus-2" | "star" | "trapezoid" | "triangle" | "x-box";
            dash: "dashed" | "dotted" | "draw" | "none" | "solid";
            url: string;
            w: number;
            h: number;
            growY: number;
            scale: number;
            labelColor: import("@tldraw/tlschema").TLDefaultColorStyle;
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            fill: "fill" | "lined-fill" | "none" | "pattern" | "semi" | "solid";
            size: "l" | "m" | "s" | "xl";
            font: import("@tldraw/tlschema").TLDefaultFontStyle;
            align: "end" | "end-legacy" | "middle" | "middle-legacy" | "start" | "start-legacy";
            verticalAlign: "end" | "middle" | "start";
            richText: {
                attrs?: any;
                content: unknown[];
                type: string;
            };
        };
    } | undefined;
    getInterpolatedProps(startShape: TLGeoShape, endShape: TLGeoShape, t: number): TLGeoShapeProps;
    /**
     * Get the unscaled dimensions from a geo shape's props
     */
    private getUnscaledGeoProps;
    /**
     * Calculate the growY needed to fit a label within a shape.
     * Returns null if no change is needed, otherwise returns the new unscaled growY value.
     */
    private calculateGrowY;
    /**
     * Calculate expanded dimensions when adding a label to a shape for the first time.
     * Ensures the shape meets minimum size requirements and is square if originally small.
     */
    private expandShapeForFirstLabel;
    private _labelSizesForGeoCache;
    /**
     * Get the cached label size for the shape. Don't call with empty rich text.
     */
    private getUnscaledLabelSize;
    /**
     * Expensively measure the unscaled label size for the shape. Avoid using it if we can.
     */
    private measureUnscaledLabelSize;
}
/** @internal */
export declare function setBatchLabelSizeCache(editor: Editor, cache: Map<TLShapeId, {
    w: number;
    h: number;
}> | null): void;
/**
 * Batch-measure all geo shape labels before the resize loop to avoid layout thrashing.
 * For each geo shape with a non-empty label that has compatible rotation, compute the
 * measurement request and batch all measurements in a single DOM pass.
 * Sets the per-editor batch cache so onResize and getGeometry can use pre-computed sizes.
 * @internal
 */
export declare function batchMeasureGeoLabels(editor: Editor, shapeSnapshots: Map<TLShapeId, {
    shape: TLShape;
    pageRotation: number;
    isAspectRatioLocked: boolean;
}>, scale: VecLike, selectionRotation: number, isAspectRatioLocked: boolean): void;
//# sourceMappingURL=GeoShapeUtil.d.ts.map