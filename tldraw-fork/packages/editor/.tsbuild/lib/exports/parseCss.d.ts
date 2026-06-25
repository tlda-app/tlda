export interface ParsedFontFace {
    fontFace: string;
    urls: {
        original: string;
        resolved: string | null;
        embedded?: Promise<string | null>;
    }[];
    fontFamilies: Set<string>;
}
export declare function parseCssImports(css: string): {
    url: string;
    extras: string;
}[];
export declare function parseCssFontFaces(css: string, baseUrl: string): ParsedFontFace[];
export declare function parseCssFontFamilyValue(value: string): Set<string>;
export declare function shouldIncludeCssProperty(property: string): boolean;
export declare function parseCss(css: string, baseUrl: string): {
    imports: {
        url: string;
        extras: string;
    }[];
    fontFaces: ParsedFontFace[];
};
export declare function parseCssValueUrls(value: string): {
    original: string;
    url: string;
}[];
//# sourceMappingURL=parseCss.d.ts.map