import { Rectangle2d, ShapeUtil, SvgExportContext, TLGeometryOpts, TLResizeInfo, TLShapeId, TLTextShape } from '@tldraw/editor';
import { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface TextShapeUtilDisplayValues {
    color: string;
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    fontWeight: string;
    fontStyle: string;
    fontVariant: string;
}
/** @public */
export interface TextShapeOptions extends ShapeOptionsWithDisplayValues<TLTextShape, TextShapeUtilDisplayValues> {
    /** How much addition padding should be added to the horizontal geometry of the shape when binding to an arrow? */
    extraArrowHorizontalPadding: number;
    /** Whether to show the outline of the text shape (using the same color as the canvas). This helps with overlapping shapes. It does not show up on Safari, where text outline is a performance issues. */
    showTextOutline: boolean;
}
/** @public */
export declare class TextShapeUtil extends ShapeUtil<TLTextShape> {
    static type: "text";
    static props: import("@tldraw/tlschema").RecordProps<TLTextShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: TextShapeOptions;
    getDefaultProps(): TLTextShape['props'];
    getMinDimensions(shape: TLTextShape): {
        width: number;
        height: number;
    };
    getGeometry(shape: TLTextShape, opts: TLGeometryOpts): Rectangle2d;
    getFontFaces(shape: TLTextShape): import("@tldraw/tlschema").TLFontFace[];
    getText(shape: TLTextShape): string;
    canEdit(shape: TLTextShape): boolean;
    isAspectRatioLocked(shape: TLTextShape): boolean;
    component(shape: TLTextShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLTextShape): Path2D | undefined;
    toSvg(shape: TLTextShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    onResize(shape: TLTextShape, info: TLResizeInfo<TLTextShape>): {
        x: number;
        y: number;
        props: {
            scale: number;
        };
        id: TLShapeId;
        type: "text";
    } | {
        id: TLShapeId;
        type: "text";
        x: number;
        y: number;
        props: {
            w: number;
            autoSize: boolean;
        };
    };
    onEditEnd(shape: TLTextShape): void;
    onBeforeUpdate(prev: TLTextShape, next: TLTextShape): {
        id: TLShapeId;
        typeName: "shape";
        type: "text";
        rotation: number;
        index: import("@tldraw/utils").IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        x: number;
        y: number;
        props: {
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            size: "l" | "m" | "s" | "xl";
            font: import("@tldraw/tlschema").TLDefaultFontStyle;
            textAlign: "end" | "middle" | "start";
            richText: {
                attrs?: any;
                content: unknown[];
                type: string;
            };
            scale: number;
            autoSize: boolean;
            w: number;
        };
    } | undefined;
}
//# sourceMappingURL=TextShapeUtil.d.ts.map