/** @public */
export declare function getSvgAsImage(svgString: string, options: {
    type: 'png' | 'jpeg' | 'webp';
    width: number;
    height: number;
    quality?: number;
    pixelRatio?: number;
}): Promise<Blob | null>;
/** @internal */
export declare function getSvgAsImageWithOptions(svgString: string, options: {
    type: 'png' | 'jpeg' | 'webp';
    width: number;
    height: number;
    quality?: number;
    pixelRatio?: number;
    trimPadding?: number;
    scale?: number;
}): Promise<{
    blob: Blob;
    width: number;
    height: number;
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
    width: number;
    height: number;
    trimPadding: number;
    scale: number;
}): Promise<{
    svg: string;
    width: number;
    height: number;
} | null>;
//# sourceMappingURL=getSvgAsImage.d.ts.map