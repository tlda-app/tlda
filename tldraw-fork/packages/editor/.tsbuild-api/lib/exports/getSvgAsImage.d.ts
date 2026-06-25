/** @public */
export declare function getSvgAsImage(svgString: string, options: {
    height: number;
    pixelRatio?: number;
    quality?: number;
    type: 'jpeg' | 'png' | 'webp';
    width: number;
}): Promise<Blob | null>;
/** @internal */
export declare function getSvgAsImageWithOptions(svgString: string, options: {
    height: number;
    pixelRatio?: number;
    quality?: number;
    scale?: number;
    trimPadding?: number;
    type: 'jpeg' | 'png' | 'webp';
    width: number;
}): Promise<{
    blob: Blob;
    height: number;
    width: number;
} | null>;
/**
 * Trims an SVG string to its visual content bounds by rendering it to a
 * temporary canvas, measuring the actual content area, then adjusting the
 * SVG's viewBox and dimensions to match.
 *
 * @param svgString - The SVG string to trim.
 * @param options - Options for trimming.
 * @returns The trimmed SVG string with updated dimensions, or null if no trimming was needed.
 *
 * @internal
 */
export declare function trimSvgToContent(svgString: string, options: {
    height: number;
    scale: number;
    trimPadding: number;
    width: number;
}): Promise<{
    height: number;
    svg: string;
    width: number;
} | null>;
//# sourceMappingURL=getSvgAsImage.d.ts.map