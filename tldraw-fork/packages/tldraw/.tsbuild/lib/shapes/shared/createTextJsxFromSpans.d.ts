import { BoxModel, Editor, TLDefaultVerticalAlignStyle, TLMeasureTextSpanOpts } from '@tldraw/editor';
export interface TLCreateTextJsxFromSpansOpts extends TLMeasureTextSpanOpts {
    verticalTextAlign: TLDefaultVerticalAlignStyle;
    offsetX: number;
    offsetY: number;
    stroke?: string;
    strokeWidth?: number;
    fill?: string;
}
/** Get an SVG element for a text shape. */
export declare function createTextJsxFromSpans(editor: Editor, spans: {
    text: string;
    box: BoxModel;
}[], opts: TLCreateTextJsxFromSpansOpts): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=createTextJsxFromSpans.d.ts.map