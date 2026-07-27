import { FontEmbedder } from './FontEmbedder';
export declare class StyleEmbedder {
    private readonly root;
    constructor(root: Element);
    private readonly styles;
    readonly fonts: FontEmbedder;
    readRootElementStyles(rootElement: Element): void;
    private readElementStyles;
    fetchResources(): Promise<void[]>;
    unwrapCustomElements(): void;
    embedStyles(): string;
    getFontFaceCss(): Promise<string>;
    dispose(): void;
}
//# sourceMappingURL=StyleEmbedder.d.ts.map