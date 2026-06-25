import { TLAssetId, TLImageAsset, TLShapeId, TLVideoAsset } from '@tldraw/editor';
/**
 * Options for {@link useImageOrVideoAsset}.
 *
 * @public
 */
export interface UseImageOrVideoAssetOptions {
    /** The asset ID you want a URL for. */
    assetId: TLAssetId | null;
    /**
     * The shape the asset is being used for. We won't update the resolved URL while the shape is
     * off-screen.
     */
    shapeId?: TLShapeId;
    /**
     * The width at which the asset will be displayed, in shape-space pixels.
     */
    width: number;
}
/**
 * This is a handy helper hook that resolves an asset to an optimized URL for a given shape, or its
 * {@link @tldraw/editor#Editor.createTemporaryAssetPreview | placeholder} if the asset is still
 * uploading. This is used in particular for high-resolution images when you want lower and higher
 * resolution depending on the size of the image on the canvas and the zoom level.
 *
 * For image scaling to work, you need to implement scaled URLs in
 * {@link @tldraw/tlschema#TLAssetStore.resolve}.
 *
 * @public
 */
export declare function useImageOrVideoAsset({ shapeId, assetId, width }: UseImageOrVideoAssetOptions): {
    asset: TLImageAsset | TLVideoAsset | null;
    url: string | null;
};
//# sourceMappingURL=useImageOrVideoAsset.d.ts.map