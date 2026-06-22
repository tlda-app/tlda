export interface ParsedFontFace {
    fontFace: string;
    urls: {
        embedded?: Promise<null | string>;
        original: string;
        resolved: null | string;
    }[];
    fontFamilies: Set<string>;
}
export declare function parseCssImports(css: string): {
    extras: string;
    url: string;
}[];
export declare function parseCssFontFaces(css: string, baseUrl: string): ParsedFontFace[];
export declare function parseCssFontFamilyValue(value: string): Set<string>;
export declare function shouldIncludeCssProperty(property: string): boolean;
export declare function parseCss(css: string, baseUrl: string): {
    fontFaces: ParsedFontFace[];
    imports: {
        extras: string;
        url: string;
    }[];
};
export declare function parseCssValueUrls(value: string): {
    original: string;
    url: string;
}[];
//# sourceMappingURL=parseCss.d.ts.map