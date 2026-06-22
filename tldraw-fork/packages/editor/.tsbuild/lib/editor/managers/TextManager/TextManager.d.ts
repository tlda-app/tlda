import { BoxModel, TLDefaultHorizontalAlignStyle } from '@tldraw/tlschema';
import type { Editor } from '../../Editor';
/**
 * The whole-pixel line-height for a given font size and tldraw's unitless line-height
 * multiplier. tldraw's theme stores line-height as a multiplier (e.g. 1.35); resolving it
 * to a whole pixel keeps line spacing identical across rendering engines, which otherwise
 * disagree on fractional line boxes (WebKit snaps them to whole pixels, Blink keeps the
 * fraction) and let multi-line text drift apart. Apply it everywhere line-height is used —
 * measurement, on-canvas render, and export — so geometry and rendering agree.
 * See https://github.com/tldraw/tldraw/issues/8970.
 *
 * @public
 */
export declare function resolveLineHeightPx(fontSize: number, lineHeight: number): number;
/** @public */
export interface BatchMeasurementRequest {
    html: string;
    opts: TLMeasureTextOpts;
}
/** @public */
export type TLMeasuredTextSize = BoxModel & {
    scrollWidth: number;
};
/** @public */
export interface TLMeasureTextOpts {
    fontStyle: string;
    fontWeight: string;
    fontFamily: string;
    fontSize: number;
    /** This must be a number, e.g. 1.35, not a pixel value. */
    lineHeight: number;
    /**
     * When maxWidth is a number, the text will be wrapped to that maxWidth. When maxWidth
     * is null, the text will be measured without wrapping, but explicit line breaks and
     * space are preserved.
     */
    maxWidth: null | number;
    minWidth?: null | number;
    padding: string;
    otherStyles?: Record<string, string>;
    disableOverflowWrapBreaking?: boolean;
    measureScrollWidth?: boolean;
}
/** @public */
export interface TLMeasureTextSpanOpts {
    overflow: 'wrap' | 'truncate-ellipsis' | 'truncate-clip';
    width: number;
    height: number;
    padding: number;
    fontSize: number;
    fontWeight: string;
    fontFamily: string;
    fontStyle: string;
    lineHeight: number;
    textAlign: TLDefaultHorizontalAlignStyle;
    otherStyles?: Record<string, string>;
    measureScrollWidth?: boolean;
}
/** @public */
export declare class TextManager {
    editor: Editor;
    private elm;
    private poolElms;
    constructor(editor: Editor);
    private createMeasurementEl;
    private resetElementStyles;
    private setElementStyles;
    private getMeasureStyles;
    dispose(): void;
    private ensurePoolSize;
    private getPoolItem;
    measureHtmlBatch(requests: BatchMeasurementRequest[]): TLMeasuredTextSize[];
    measureText(textToMeasure: string, opts: TLMeasureTextOpts): TLMeasuredTextSize;
    measureHtml(html: string, opts: TLMeasureTextOpts): TLMeasuredTextSize;
    /**
     * Given an html element, measure the position of each span of unbroken
     * word/white-space characters within any text nodes it contains.
     */
    measureElementTextNodeSpans(element: HTMLElement, { shouldTruncateToFirstLine }?: {
        shouldTruncateToFirstLine?: boolean;
    }): {
        spans: {
            box: BoxModel;
            text: string;
        }[];
        didTruncate: boolean;
    };
    /**
     * Measure text into individual spans. Spans are created by rendering the
     * text, then dividing it up according to line breaks and word boundaries.
     *
     * It works by having the browser render the text, then measuring the
     * position of each character. You can use this to replicate the text-layout
     * algorithm of the current browser in e.g. an SVG export.
     */
    measureTextSpans(textToMeasure: string, opts: TLMeasureTextSpanOpts): {
        text: string;
        box: BoxModel;
    }[];
}
//# sourceMappingURL=TextManager.d.ts.map