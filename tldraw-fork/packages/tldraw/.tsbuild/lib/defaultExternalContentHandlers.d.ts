import { Editor, TLAsset, TLAssetId, TLBookmarkAsset, TLBookmarkShape, TLContent, TLFileExternalAsset, TLFileReplaceExternalContent, TLShapeId, TLUrlExternalAsset, VecLike } from '@tldraw/editor';
import { TLUiToastsContextType } from './ui/context/toasts';
import { useTranslation } from './ui/hooks/useTranslation/useTranslation';
/**
 * 5000px
 * @public
 */
export declare const DEFAULT_MAX_IMAGE_DIMENSION = 5000;
/**
 * 10mb
 * @public
 */
export declare const DEFAULT_MAX_ASSET_SIZE: number;
/** @public */
export interface TLExternalContentProps {
    /**
     * The maximum dimension (width or height) of an image. Images larger than this will be rescaled
     * to fit. Defaults to infinity.
     */
    maxImageDimension?: number;
    /**
     * The maximum size (in bytes) of an asset. Assets larger than this will be rejected. Defaults
     * to 10mb (10 * 1024 * 1024).
     */
    maxAssetSize?: number;
    /**
     * The mime types of images that are allowed to be handled. When passed to
     * the `Tldraw` component, this also reconfigures the default `ImageAssetUtil`
     * to only accept files matching these types. If you only want to accept a
     * subset of image types and want to additionally block videos, pass
     * `acceptedVideoMimeTypes={[]}`. A file is accepted if its MIME type is in
     * this list, in `acceptedVideoMimeTypes`, or if any registered asset util
     * accepts it.
     */
    acceptedImageMimeTypes?: readonly string[];
    /**
     * The mime types of videos that are allowed to be handled. When passed to
     * the `Tldraw` component, this also reconfigures the default `VideoAssetUtil`
     * to only accept files matching these types. A file is accepted if its MIME
     * type is in this list, in `acceptedImageMimeTypes`, or if any registered
     * asset util accepts it.
     */
    acceptedVideoMimeTypes?: readonly string[];
}
/** @public */
export interface TLDefaultExternalContentHandlerOpts extends TLExternalContentProps {
    toasts: TLUiToastsContextType;
    msg: ReturnType<typeof useTranslation>;
}
/** @public */
export declare function registerDefaultExternalContentHandlers(editor: Editor, options: TLDefaultExternalContentHandlerOpts): void;
/** @public */
export declare function defaultHandleExternalFileAsset(editor: Editor, { file, assetId }: TLFileExternalAsset, options: TLDefaultExternalContentHandlerOpts): Promise<TLAsset<"bookmark" | "image" | "video">>;
/** @public */
export declare function defaultHandleExternalFileReplaceContent(editor: Editor, { file, shapeId }: TLFileReplaceExternalContent, options: TLDefaultExternalContentHandlerOpts): Promise<TLAsset | undefined>;
/** @public */
export declare function defaultHandleExternalUrlAsset(editor: Editor, { url }: TLUrlExternalAsset, { toasts, msg }: TLDefaultExternalContentHandlerOpts): Promise<TLBookmarkAsset>;
/** @public */
export declare function defaultHandleExternalSvgTextContent(editor: Editor, { point, text }: {
    point?: VecLike;
    text: string;
}): Promise<void>;
/** @public */
export declare function defaultHandleExternalEmbedContent<T>(editor: Editor, { point, url, embed }: {
    point?: VecLike;
    url: string;
    embed: T;
}): void;
/** @public */
export declare function defaultHandleExternalFileContent(editor: Editor, { point, files }: {
    point?: VecLike;
    files: File[];
}, options: TLDefaultExternalContentHandlerOpts): Promise<void>;
/** @public */
export declare function defaultHandleExternalTextContent(editor: Editor, { point, text, html }: {
    point?: VecLike;
    text: string;
    html?: string;
}): Promise<void>;
/** @public */
export declare function defaultHandleExternalUrlContent(editor: Editor, { point, url }: {
    point?: VecLike;
    url: string;
}, { toasts, msg }: TLDefaultExternalContentHandlerOpts): Promise<void>;
/** @public */
export declare function defaultHandleExternalTldrawContent(editor: Editor, { point, content }: {
    point?: VecLike;
    content: TLContent;
}): Promise<void>;
/** @public */
export declare function defaultHandleExternalExcalidrawContent(editor: Editor, { point, content }: {
    point?: VecLike;
    content: any;
}): Promise<void>;
/**
 * A helper function for an external content handler. It creates bookmarks,
 * images or video shapes corresponding to the type of assets provided.
 *
 * @param editor - The editor instance
 *
 * @param assets - An array of asset Ids
 *
 * @param position - the position at which to create the shapes
 *
 * @public
 */
export declare function createShapesForAssets(editor: Editor, assets: TLAsset[], position: VecLike): Promise<TLShapeId[]>;
/**
 * Repositions selected shapes do that the center of the group is
 * at the provided position
 *
 * @param editor - The editor instance
 *
 * @param position - the point to center the shapes around
 *
 * @public
 */
export declare function centerSelectionAroundPoint(editor: Editor, position: VecLike): void;
/** @public */
export declare function createEmptyBookmarkShape(editor: Editor, url: string, position: VecLike): TLBookmarkShape;
/**
 * Checks if a file is allowed to be uploaded. If it is not, it will show a toast explaining why to the user.
 *
 * @param editor - The editor instance
 * @param file - The file to check
 * @param options - The options for the external content handler
 * @returns True if the file is allowed, false otherwise
 * @public
 */
export declare function notifyIfFileNotAllowed(editor: Editor, file: File, options: TLDefaultExternalContentHandlerOpts): boolean;
/** @public */
export declare function getAssetInfo(editor: Editor, file: File, assetId?: TLAssetId): Promise<TLAsset | null>;
//# sourceMappingURL=defaultExternalContentHandlers.d.ts.map