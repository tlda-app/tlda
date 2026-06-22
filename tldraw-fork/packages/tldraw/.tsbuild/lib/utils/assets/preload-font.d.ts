/** @public */
export interface TLTypeFace {
    url: string;
    display?: any;
    featureSettings?: string;
    stretch?: string;
    style?: string;
    unicodeRange?: string;
    variant?: string;
    weight?: string;
    format?: string;
}
/** @public */
export declare function preloadFont(id: string, font: TLTypeFace, targetDocument?: Document): Promise<FontFace>;
//# sourceMappingURL=preload-font.d.ts.map