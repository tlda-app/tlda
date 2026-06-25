import { TLAssetId } from '@tldraw/tlschema';
import { ReactElement, ReactNode } from 'react';
import type { Editor } from '../Editor';
/** @public */
export interface SvgExportDef {
    key: string;
    getElement(): Promise<ReactElement | null> | ReactElement | null;
}
/** @public */
export interface SvgExportContext {
    /**
     * Add contents to the `<defs>` section of the export SVG. Each export def should have a unique
     * key. If multiple defs come with the same key, only one will be added.
     */
    addExportDef(def: SvgExportDef): void;
    /**
     * Cause the SVG export to be delayed until the returned promise is resolved. This is useful if
     * e.g. your shape loads data dynamically, and you need to prevent the export from happening
     * until after the data is loaded.
     *
     * See also the {@link useDelaySvgExport} hook, which may be a more convenient way to use this
     * method depending on your use-case.
     */
    waitUntil(promise: Promise<void>): void;
    /**
     * Resolve an asset URL in the context of this export. Supply the asset ID and the width in
     * shape-pixels it'll be displayed at, and this will resolve the asset according to the export
     * options.
     */
    resolveAssetUrl(assetId: TLAssetId, width: number): Promise<string | null>;
    /**
     * Whether the export should be in dark mode.
     */
    readonly isDarkMode: boolean;
    /**
     * The color mode to use for this export.
     */
    readonly colorMode: 'light' | 'dark';
    /**
     * The scale of the export - how much CSS pixels will be scaled up/down by.
     */
    readonly scale: number;
    /**
     * Use this value to optionally downscale images in the export. If we're exporting directly to
     * an SVG, this will usually be null, and you shouldn't downscale images. If the export is to a
     * raster format like PNG, this will be the number of raster pixels in the resulting bitmap per
     * CSS pixel in the resulting SVG.
     */
    readonly pixelRatio: number | null;
}
export declare function SvgExportContextProvider({ context, editor, children }: {
    context: SvgExportContext;
    editor: Editor;
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/**
 * Returns the current SVG export context. Returns null if the component isn't being rendered for an
 * SVG export.
 *
 * @public
 */
export declare function useSvgExportContext(): SvgExportContext | null;
/**
 * Delay an SVG export until the returned function is called. This is useful if e.g. your shape
 * loads data dynamically, and you need to prevent the export from happening until after the data is
 * loaded.
 *
 * If used outside of an SVG export, this hook has no effect.
 *
 * @example
 * ```tsx
 * const readyForExport = useDelaySvgExport()
 *
 * return <MyDynamicComponent onDataLoaded={() => readyForExport()} />
 * ```
 *
 * @public
 */
export declare function useDelaySvgExport(): () => void;
//# sourceMappingURL=SvgExportContext.d.ts.map