/*!
 * SVG/attribute allowlists and URI sanitization approach derived from DOMPurify.
 * DOMPurify — MIT License, Copyright (c) 2015 Mario Heiderich
 * https://github.com/cure53/DOMPurify/blob/main/LICENSE
 */
/**
 * Sanitizes an SVG string by removing dangerous elements, attributes, and URIs
 * while preserving safe content including foreignObject (for text rendering),
 * style elements (for fonts with data: URLs), and animation elements.
 * Embedded SVG data URIs on `<image>`/`<feImage>` are recursively sanitized.
 *
 * Returns the sanitized SVG string, or an empty string if the input was
 * malformed (parse error) or contained no safe content after sanitization.
 *
 * @public
 */
export declare function sanitizeSvg(svgText: string): string;
//# sourceMappingURL=sanitizeSvg.d.ts.map