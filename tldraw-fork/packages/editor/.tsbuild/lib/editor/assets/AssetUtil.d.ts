import { LegacyMigrations, MigrationSequence } from '@tldraw/store';
import { RecordProps, TLAsset, TLAssetId, TLPropsMigrations, TLUnknownAsset } from '@tldraw/tlschema';
import type { Editor } from '../Editor';
/** @public */
export interface TLAssetUtilConstructor<T extends TLAsset = TLAsset, U extends AssetUtil<T> = AssetUtil<T>> {
    new (editor: Editor): U;
    type: T['type'];
    props?: RecordProps<T>;
    migrations?: LegacyMigrations | TLPropsMigrations | MigrationSequence;
}
/**
 * Abstract base class for defining asset-type-specific behavior.
 *
 * Each asset type (image, video, bookmark, etc.) has a corresponding AssetUtil that handles
 * type-specific operations like determining supported MIME types and creating assets from files.
 *
 * @public
 */
export declare abstract class AssetUtil<Asset extends TLAsset = TLAsset> {
    editor: Editor;
    /** Configure this asset util's {@link AssetUtil.options | `options`}. */
    static configure<T extends TLAssetUtilConstructor<any, any>>(this: T, options: T extends new (...args: any[]) => {
        options: infer Options;
    } ? Partial<Options> : never): T;
    constructor(editor: Editor);
    /**
     * Options for this asset util. Override this to provide customization options for your asset.
     * Use {@link AssetUtil.configure} to customize existing asset utils.
     */
    options: {};
    static props?: RecordProps<TLUnknownAsset>;
    static migrations?: LegacyMigrations | TLPropsMigrations | MigrationSequence;
    /**
     * The type of the asset util, which should match the asset's type.
     */
    static type: string;
    /**
     * Get the default props for an asset of this type.
     */
    abstract getDefaultProps(): Asset['props'];
    /**
     * Get the MIME types that this asset type supports.
     * Return an empty array if this asset type doesn't support files (e.g. bookmarks).
     */
    getSupportedMimeTypes(): readonly string[];
    /**
     * Check whether this asset type accepts a given MIME type.
     */
    acceptsMimeType(mimeType: string): boolean;
    /**
     * Create an asset from a file. Return null if this asset type can't handle the file.
     */
    getAssetFromFile(_file: File, _assetId: TLAssetId): Promise<Asset | null>;
}
//# sourceMappingURL=AssetUtil.d.ts.map