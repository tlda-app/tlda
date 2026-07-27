export declare const SVG_EXPORT_CLASSNAME = "tldraw-svg-export";
/**
 * Because SVGs cannot refer to external CSS/font resources, any web fonts used in the SVG must be
 * embedded as data URLs in inlined @font-face declarations. This class is responsible for
 * collecting used font faces and creating a CSS string with embedded fonts that can be used in the
 * SVG.
 *
 * It works in three steps:
 * 1. `startFindingDocumentFontFaces` - this traverses the given document, finding all the
 *    stylesheets in use (including those imported via `@import` rules etc) and extracting the
 *    @font-face declarations from them.
 * 2. `onFontFamilyValue` - as `StyleEmbedder` traverses the SVG, it will call this method with the
 *    value of the `font-family` property for each element. We parse out the font names in use, and
 *    mark them as needing to be embedded.
 * 3. `createCss` - once all the font families have been collected, this method will return a CSS
 *    string with embedded fonts.
 */
export declare class FontEmbedder {
    private fontFacesPromise;
    private readonly foundFontNames;
    private readonly fontFacesToEmbed;
    private readonly pendingPromises;
    startFindingDocumentFontFaces(doc: Document): void;
    onFontFamilyValue(fontFamilyValue: string): void;
    createCss(): Promise<string>;
}
//# sourceMappingURL=FontEmbedder.d.ts.map