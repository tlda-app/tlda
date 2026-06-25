import { TLFontFace, TLShape, TLShapeId } from '@tldraw/tlschema';
import type { Editor } from '../../Editor';
/** @public */
export declare class FontManager {
    private readonly editor;
    private readonly assetUrls?;
    constructor(editor: Editor, assetUrls?: {
        [key: string]: string | undefined;
    } | undefined);
    dispose(): void;
    private shapeFontFacesCache;
    private shapeFontLoadStateCache;
    getShapeFontFaces(shape: TLShape | TLShapeId): TLFontFace[];
    trackFontsForShape(shape: TLShape | TLShapeId): void;
    loadRequiredFontsForCurrentPage(limit?: number): Promise<void>;
    private readonly fontStates;
    private getFontState;
    ensureFontIsLoaded(font: TLFontFace): Promise<void>;
    private fontsToLoad;
    requestFonts(fonts: TLFontFace[]): void;
    private findOrCreateFontFace;
    toEmbeddedCssDeclaration(font: TLFontFace): Promise<string>;
}
/**
 * Resets the per-document font-face cache. Only intended for tests.
 * @internal
 */
export declare function clearFontFaceCacheForTests(): void;
//# sourceMappingURL=FontManager.d.ts.map