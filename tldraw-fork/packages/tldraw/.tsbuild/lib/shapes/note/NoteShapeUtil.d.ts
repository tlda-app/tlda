import { Group2d, IndexKey, ShapeUtil, SvgExportContext, TLHandle, TLNoteShape, TLNoteShapeProps, TLResizeInfo, TLShapeId } from '@tldraw/editor';
import { ShapeOptionsWithDisplayValues } from '../shared/getDisplayValues';
/** @public */
export interface NoteShapeUtilDisplayValues {
    noteWidth: number;
    noteHeight: number;
    noteBackgroundColor: string;
    borderColor: string;
    borderWidth: number;
    labelColor: string;
    labelFontFamily: string;
    labelFontSize: number;
    labelLineHeight: number;
    labelFontWeight: string;
    labelFontVariant: string;
    labelFontStyle: string;
    labelPadding: number;
    labelHorizontalAlign: 'start' | 'center' | 'end';
    labelVerticalAlign: 'start' | 'middle' | 'end';
}
/** @public */
export interface NoteShapeOptions extends ShapeOptionsWithDisplayValues<TLNoteShape, NoteShapeUtilDisplayValues> {
    /**
     * How should the note shape resize? By default it does not resize (except automatically based on its text content),
     * but you can set it to be user-resizable using scale.
     */
    resizeMode: 'none' | 'scale';
}
/** @public */
export declare class NoteShapeUtil extends ShapeUtil<TLNoteShape> {
    static type: "note";
    static props: import("@tldraw/tlschema").RecordProps<TLNoteShape>;
    static migrations: import("@tldraw/tlschema").TLPropsMigrations;
    options: NoteShapeOptions;
    canEdit(shape: TLNoteShape): boolean;
    hideResizeHandles(shape: TLNoteShape): boolean;
    isAspectRatioLocked(shape: TLNoteShape): boolean;
    hideSelectionBoundsFg(shape: TLNoteShape): boolean;
    getDefaultProps(): TLNoteShape['props'];
    getGeometry(shape: TLNoteShape): Group2d;
    getHandles(shape: TLNoteShape): TLHandle[];
    onResize(shape: any, info: TLResizeInfo<any>): {
        x: number;
        y: number;
        props: {
            scale: number;
        };
    } | undefined;
    getText(shape: TLNoteShape): string;
    getReferencedUserIds(shape: TLNoteShape): string[];
    getFontFaces(shape: TLNoteShape): import("@tldraw/tlschema").TLFontFace[];
    component(shape: TLNoteShape): import("react/jsx-runtime").JSX.Element;
    getIndicatorPath(shape: TLNoteShape): Path2D;
    toSvg(shape: TLNoteShape, ctx: SvgExportContext): import("react/jsx-runtime").JSX.Element;
    onBeforeCreate(next: TLNoteShape): {
        id: TLShapeId;
        typeName: "shape";
        type: "note";
        x: number;
        y: number;
        rotation: number;
        index: IndexKey;
        parentId: import("@tldraw/tlschema").TLParentId;
        isLocked: boolean;
        opacity: number;
        meta: import("@tldraw/utils").JsonObject;
        props: {
            color: import("@tldraw/tlschema").TLDefaultColorStyle;
            labelColor: import("@tldraw/tlschema").TLDefaultColorStyle;
            size: "l" | "m" | "s" | "xl";
            font: import("@tldraw/tlschema").TLDefaultFontStyle;
            align: "end" | "end-legacy" | "middle" | "middle-legacy" | "start" | "start-legacy";
            verticalAlign: "end" | "middle" | "start";
            url: string;
            richText: {
                attrs?: any;
                content: unknown[];
                type: string;
            };
            scale: number;
            textFirstEditedBy: string | null;
            growY: number;
            fontSizeAdjustment: number;
        };
    } | undefined;
    onBeforeUpdate(prev: TLNoteShape, next: TLNoteShape): TLNoteShape | undefined;
    getInterpolatedProps(startShape: TLNoteShape, endShape: TLNoteShape, t: number): TLNoteShapeProps;
    /**
     * Get the growY and fontSizeAdjustment for a shape.
     */
    private getNoteSizeAdjustments;
    private _labelSizesForNoteCache;
    /**
     * Get the cached label size for the shape.
     */
    private getLabelSize;
    /**
     * Expensively measure the label size for a note shape.
     */
    private measureNoteLabelSize;
}
//# sourceMappingURL=NoteShapeUtil.d.ts.map